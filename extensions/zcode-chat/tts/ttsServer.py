#!/usr/bin/env python3
"""zcode-chat 桌面精灵的本地 TTS 服务（Qwen3-TTS，Hugging Face 开源权重，MPS/CPU）。

扩展侧 mascotTts.ts 以 `python ttsServer.py --refs <dir>` 拉起本进程，经 stdout
的 `PORT=<n>` 行拿到端口，然后走 localhost HTTP：

    GET  /voices       -> [{name, value, locale}]  参考音色清单（不依赖模型加载）
    GET  /cache        -> {entries, dir}           合成缓存条目（按条可删）
    POST /cache/delete -> {"key": str}             删单条缓存
    POST /cache/clear  -> {}                       清空缓存
    POST /synthesize   -> wav bytes                {"text": str, "voice": "clone:<stem>",
                                                   "ref_path": "/abs/native.mp3" (角色原声克隆)}
												   命中缓存时直接返回，不再过模型

音色 = 参考音频克隆：refs 目录里每个 `名字.wav`（可选同名 `.txt` 写参考文案，
缺省走 x_vector_only）就是一个可选择的音色，按文件放进去即生效。
真人录音（官方角色语音等）效果远好于合成音；5-10 秒、干净干声最佳。

合成缓存落在 refs 同级的 `mascot-tts-cache/`（每条一个 `<key>.wav` + `<key>.json`
元数据），key = sha1(voice|ref_path|text)，重复台词零成本秒回。

参考目录为空时才用 macOS `say` 生成 4 个占位种子兜底（下表 SEEDS）。
"""

from __future__ import annotations

import argparse
import io
import json
import subprocess
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# 种子参考音色：refs 目录为空时用 macOS say 生成（占位数据，可整文件删除替换）。
SEEDS: list[tuple[str, str, str]] = [
	("seed_liang", "Meijia", "大家好，我是你的桌面小伙伴。今天也要一起加油哦，写代码的时候记得休息一下眼睛，喝口水。"),
	("seed_rou", "Tingting", "好呀，那我们开始吧。慢慢来不着急，我会一直在这里陪着你的，有什么想说的都可以告诉我。"),
	("seed_nan", "Yu-shu", "收到，交给我吧。这个任务看起来不难，我们一步一步把它做完，做完记得检查一遍再收工。"),
	("seed_shao", "Sinji", "嗯哼，看我的。这种小问题马上就能搞定，等着瞧吧，我可是很厉害的。"),
]

REF_AUDIO_SUFFIXES = (".wav", ".flac", ".mp3", ".ogg", ".m4a", ".aac")
QWEN_REPO = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
QWEN_LANGUAGE = "Chinese"


def log(message: str) -> None:
	print(f"LOG={message}", flush=True)


def seed_torch(voice: str, text: str) -> None:
	"""采样解码前定种子（参考 audio-i18n-demo 的做法）。

	Qwen3-TTS 贪心/无种子采样会把句子拖得又平又慢；按 (音色, 台词) 固定种子，
	采样解码既自然又可复现（同句同音色结果一致，正好配合合成缓存）。
	"""
	import torch
	import zlib

	torch.manual_seed(zlib.crc32(f"{voice}|{text}".encode("utf-8")) & 0x7FFFFFFF)


def polish(samples, sample_rate: int):
	"""裁掉首尾静音 + 响度归一（模型输出忽大忽小、常带半秒空白）。"""
	import numpy as np

	data = np.asarray(samples, dtype=np.float32).reshape(-1)
	if data.size == 0:
		return data
	envelope = np.abs(data)
	gate = max(float(envelope.max()) * 0.02, 0.005)
	idx = np.where(envelope > gate)[0]
	if idx.size:
		pad = int(sample_rate * 0.06)
		start = max(0, int(idx[0]) - pad)
		end = min(data.size, int(idx[-1]) + pad)
		data = data[start:end]
	rms = float(np.sqrt(np.mean(np.square(data)))) if data.size else 0.0
	if rms > 1e-5:
		data = data * (0.09 / rms)
		peak = float(np.abs(data).max())
		if peak > 0.97:
			data = data * (0.97 / peak)
	return data


def seed_refs(refs_dir: Path) -> None:
	"""refs 目录为空时用 say 生成种子参考音色（macOS only，占位数据）。"""
	if sys.platform != "darwin":
		return
	for stem, voice, text in SEEDS:
		wav_path = refs_dir / f"{stem}.wav"
		txt_path = refs_dir / f"{stem}.txt"
		if wav_path.exists() and txt_path.exists():
			continue
		try:
			subprocess.run(
				["say", "-o", str(wav_path), "--data-format=LEI16@24000", "-v", voice, text],
				check=True,
				timeout=20,
				capture_output=True,
			)
			txt_path.write_text(text, encoding="utf-8")
			log(f"seeded voice {stem} via say")
		except Exception as exc:  # noqa: BLE001 - 种子失败不致命
			log(f"seed {stem} failed: {exc}")


def scan_refs(refs_dir: Path) -> list[dict]:
	voices: list[dict] = []
	for path in sorted(refs_dir.iterdir()):
		if path.suffix.lower() not in REF_AUDIO_SUFFIXES or not path.is_file():
			continue
		stem = path.stem
		voices.append({"name": stem, "value": f"clone:{stem}", "locale": "zh"})
	return voices


def ref_to_wav(ref_audio: Path, refs_dir: Path) -> Path:
	"""非 wav 参考（模型自带 mp3/m4a 等）转成 24k 单声道 wav 并缓存。

	模型目录里的原声是只读素材，转换结果落在 refs 目录的 .conv/ 下。
	"""
	if ref_audio.suffix.lower() == ".wav":
		return ref_audio
	import hashlib

	stat = ref_audio.stat()
	key = hashlib.sha1(f"{ref_audio}|{stat.st_mtime_ns}|{stat.st_size}".encode()).hexdigest()[:16]
	conv_dir = refs_dir / ".conv"
	target = conv_dir / f"{ref_audio.stem[:40]}-{key}.wav"
	if target.exists():
		return target
	conv_dir.mkdir(parents=True, exist_ok=True)
	for cmd in (
		["afconvert", "-f", "WAVE", "-d", "LEI16@24000", "-c", "1", str(ref_audio), str(target)],
		["ffmpeg", "-y", "-i", str(ref_audio), "-ar", "24000", "-ac", "1", str(target)],
	):
		try:
			subprocess.run(cmd, check=True, timeout=60, capture_output=True)
			if target.exists() and target.stat().st_size > 44:
				return target
		except Exception:  # noqa: BLE001 - 换下一条命令再试
			continue
	target.unlink(missing_ok=True)
	raise RuntimeError(f"无法把 {ref_audio.suffix} 转成 wav（需要 afconvert 或 ffmpeg）")


def cache_dir(refs_dir: Path) -> Path:
	"""合成缓存目录：跟 refs 目录同级，换音色池不会误伤已合成台词。"""
	return refs_dir.parent / "mascot-tts-cache"


def _hex(value: str) -> str:
	return "".join(ch for ch in value.lower() if ch in "0123456789abcdef")


def cache_key(voice: str, ref_path: str, text: str) -> str:
	import hashlib

	return hashlib.sha1(f"{voice}|{ref_path}|{text}".encode("utf-8")).hexdigest()[:20]


def cache_get(refs_dir: Path, key: str) -> bytes | None:
	try:
		data = (cache_dir(refs_dir) / f"{_hex(key)}.wav").read_bytes()
		return data if len(data) > 44 else None
	except OSError:
		return None


def cache_put(refs_dir: Path, key: str, meta: dict, wav_bytes: bytes) -> None:
	base = cache_dir(refs_dir)
	base.mkdir(parents=True, exist_ok=True)
	(base / f"{key}.wav").write_bytes(wav_bytes)
	(base / f"{key}.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")


def _wav_seconds(path: Path) -> float:
	try:
		with wave.open(str(path), "rb") as wav:
			return round(wav.getnframes() / float(wav.getframerate() or 1), 1)
	except Exception:  # noqa: BLE001 - 列表元数据尽力而为
		return 0.0


def cache_list(refs_dir: Path) -> list[dict]:
	"""缓存条目清单（含 wav 时长），json 残缺/孤儿条目顺手清掉。"""
	entries: list[dict] = []
	base = cache_dir(refs_dir)
	if not base.is_dir():
		return entries
	for meta_path in sorted(base.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
		try:
			meta = json.loads(meta_path.read_text(encoding="utf-8"))
		except Exception:  # noqa: BLE001
			continue
		wav_path = meta_path.with_suffix(".wav")
		if not wav_path.is_file():
			meta_path.unlink(missing_ok=True)
			continue
		entries.append({
			"key": str(meta.get("key") or meta_path.stem),
			"text": str(meta.get("text") or ""),
			"voice": str(meta.get("voice") or ""),
			"refPath": str(meta.get("refPath") or ""),
			"seconds": _wav_seconds(wav_path),
			"bytes": wav_path.stat().st_size,
			"created": meta_path.stat().st_mtime,
		})
	return entries


def cache_delete(refs_dir: Path, key: str) -> None:
	safe = _hex(key)[:20]
	if not safe:
		return
	base = cache_dir(refs_dir)
	(base / f"{safe}.wav").unlink(missing_ok=True)
	(base / f"{safe}.json").unlink(missing_ok=True)


def cache_clear(refs_dir: Path) -> int:
	base = cache_dir(refs_dir)
	removed = 0
	if base.is_dir():
		for path in base.iterdir():
			if path.is_file():
				path.unlink(missing_ok=True)
				removed += 1
	return removed


class TtsEngine:
	"""Qwen3-TTS 懒加载 + 克隆 prompt 缓存（照抄 audio-i18n-demo 的做法）。"""

	def __init__(self) -> None:
		self._model = None
		self._prompt = None
		self._prompt_key: tuple[str, str, bool] | None = None
		self._lock = threading.Lock()
		self.ready = threading.Event()
		self.failed: str | None = None
		threading.Thread(target=self._load, daemon=True).start()

	def _load(self):
		try:
			import torch
			from qwen_tts import Qwen3TTSModel

			device = "mps" if torch.backends.mps.is_available() else "cpu"
			log(f"loading {QWEN_REPO} on {device} (first line will be slow)")
			self._model = Qwen3TTSModel.from_pretrained(
				QWEN_REPO,
				device_map=device,
				dtype=torch.float32,
				attn_implementation="sdpa",
			)
			log("model ready")
		except Exception as exc:  # noqa: BLE001 - 上报给合成请求
			self.failed = f"{type(exc).__name__}: {exc}"
			log(f"model load failed: {self.failed}")
		finally:
			self.ready.set()

	def voice_list(self) -> list[dict]:
		"""内置 speaker 表（Base 版通常没有），模型就绪后才能问。"""
		if not self.ready.wait(timeout=600) or self._model is None:
			return []
		try:
			speakers = self._model.get_supported_speakers()  # type: ignore[union-attr]
		except Exception:  # noqa: BLE001 - Base 版无内置音色属正常
			return []
		return [
			{"name": str(s), "value": f"builtin:{s}", "locale": "zh"}
			for s in (speakers or [])
		]

	def _clone_prompt(self, ref_audio: Path, ref_text: str):
		x_vector_only = not ref_text.strip()
		key = (str(ref_audio), ref_text.strip(), x_vector_only)
		if self._prompt is not None and self._prompt_key == key:
			return self._prompt
		kwargs: dict = {"ref_audio": str(ref_audio), "x_vector_only_mode": x_vector_only}
		if not x_vector_only:
			kwargs["ref_text"] = ref_text.strip()
		self._prompt = self._model.create_voice_clone_prompt(**kwargs)  # type: ignore[union-attr]
		self._prompt_key = key
		return self._prompt

	def synthesize(self, text: str, voice: str, refs_dir: Path, ref_path: str = "") -> tuple[bytes, int]:
		if not self.ready.wait(timeout=600):
			raise RuntimeError("model still loading")
		if self._model is None:
			raise RuntimeError(f"model unavailable: {self.failed}")
		with self._lock:  # MPS 上串行生成
			seed_torch(voice or ref_path or "", text)
			if ref_path:
				# 角色原声：直接从模型目录里的音频克隆（无逐字文案 → x_vector_only）。
				ref_audio = Path(ref_path).expanduser()
				if not ref_audio.is_file() or ref_audio.suffix.lower() not in REF_AUDIO_SUFFIXES:
					raise RuntimeError(f"bad ref_path: {ref_path}")
				wav = ref_to_wav(ref_audio, refs_dir)
				ref_text = ""
				txt = ref_audio.with_suffix(".txt")
				if txt.exists():
					ref_text = txt.read_text(encoding="utf-8")
				prompt = self._clone_prompt(wav, ref_text)
				wavs, sample_rate = self._model.generate_voice_clone(
					text=text, language=QWEN_LANGUAGE, voice_clone_prompt=prompt,
					non_streaming_mode=True,
				)
			elif voice.startswith("builtin:"):
				wavs, sample_rate = self._model.generate_custom_voice(  # type: ignore[union-attr]
					text=text, speaker=voice[len("builtin:"):], language=QWEN_LANGUAGE,
				)
			else:
				stem = voice[len("clone:"):] if voice.startswith("clone:") else voice
				ref_audio = None
				for suffix in REF_AUDIO_SUFFIXES:
					candidate = refs_dir / f"{stem}{suffix}"
					if candidate.exists():
						ref_audio = candidate
						break
				if ref_audio is None:
					raise RuntimeError(f"no reference audio for {stem} in {refs_dir}")
				ref_text = ""
				txt = refs_dir / f"{stem}.txt"
				if txt.exists():
					ref_text = txt.read_text(encoding="utf-8")
				prompt = self._clone_prompt(ref_audio, ref_text)
				wavs, sample_rate = self._model.generate_voice_clone(
					text=text, language=QWEN_LANGUAGE, voice_clone_prompt=prompt,
					non_streaming_mode=True,
				)
		audio = polish(wavs[0], int(sample_rate))
		pcm, rate = to_int16_pcm(audio, int(sample_rate))
		return pcm_to_wav(pcm, rate), rate


def to_int16_pcm(samples, sample_rate: int) -> tuple[bytes, int]:
	import numpy as np

	data = np.asarray(samples, dtype=np.float32).reshape(-1)
	pcm = np.clip(data, -1.0, 1.0)
	pcm = (pcm * 32767.0).astype("<i2").tobytes()
	return pcm, sample_rate


def pcm_to_wav(pcm: bytes, sample_rate: int) -> bytes:
	buffer = io.BytesIO()
	with wave.open(buffer, "wb") as wav:
		wav.setnchannels(1)
		wav.setsampwidth(2)
		wav.setframerate(sample_rate)
		wav.writeframes(pcm)
	return buffer.getvalue()


class Handler(BaseHTTPRequestHandler):
	server_version = "zcode-tts/1.1"
	engine: TtsEngine
	refs_dir: Path

	def log_message(self, fmt: str, *args) -> None:  # 静默默认访问日志
		pass

	def _json(self, status: int, payload: dict) -> None:
		body = json.dumps(payload).encode("utf-8")
		self.send_response(status)
		self.send_header("Content-Type", "application/json; charset=utf-8")
		self.send_header("Content-Length", str(len(body)))
		self.end_headers()
		self.wfile.write(body)

	def _read_json(self) -> dict:
		length = int(self.headers.get("Content-Length") or 0)
		try:
			return json.loads(self.rfile.read(length) or b"{}")
		except Exception:  # noqa: BLE001
			return {}

	def do_GET(self):  # noqa: N802 - http.server 约定
		if self.path == "/cache":
			self._json(200, {"entries": cache_list(self.refs_dir), "dir": str(cache_dir(self.refs_dir))})
			return
		if self.path != "/voices":
			self._json(404, {"error": "not found"})
			return
		try:
			voices = scan_refs(self.refs_dir)
			if not voices:
				self.refs_dir.mkdir(parents=True, exist_ok=True)
				seed_refs(self.refs_dir)
				voices = scan_refs(self.refs_dir)
			voices.extend(self.engine.voice_list())
			self._json(200, {"voices": voices})
		except Exception as exc:  # noqa: BLE001
			self._json(500, {"error": str(exc)})

	def do_POST(self):  # noqa: N802
		if self.path == "/cache/delete":
			cache_delete(self.refs_dir, str(self._read_json().get("key") or ""))
			self._json(200, {"entries": cache_list(self.refs_dir)})
			return
		if self.path == "/cache/clear":
			removed = cache_clear(self.refs_dir)
			log(f"cache cleared ({removed} files)")
			self._json(200, {"entries": []})
			return
		if self.path != "/synthesize":
			self._json(404, {"error": "not found"})
			return
		try:
			payload = self._read_json()
			text = str(payload.get("text") or "").strip()[:120]
			voice = str(payload.get("voice") or "").strip()
			ref_path = str(payload.get("ref_path") or "").strip()
			if not text:
				raise RuntimeError("empty text")
			if not voice and not ref_path:
				voices = scan_refs(self.refs_dir)
				if not voices:
					self.refs_dir.mkdir(parents=True, exist_ok=True)
					seed_refs(self.refs_dir)
					voices = scan_refs(self.refs_dir)
				if not voices:
					raise RuntimeError(f"no voices; drop a reference wav into {self.refs_dir}")
				voice = voices[0]["value"]
			key = cache_key(voice, ref_path, text)
			cached = cache_get(self.refs_dir, key)
			if cached is not None:
				wav_bytes = cached
				log(f"tts cache-hit key={key} voice={voice or ref_path}")
			else:
				wav_bytes = self.engine.synthesize(text, voice, self.refs_dir, ref_path)[0]
				cache_put(self.refs_dir, key, {
					"key": key,
					"text": text,
					"voice": voice,
					"refPath": ref_path,
				}, wav_bytes)
				log(f"tts synth key={key} voice={voice or ref_path} text={text[:18]}")
			self.send_response(200)
			self.send_header("Content-Type", "audio/wav")
			self.send_header("Content-Length", str(len(wav_bytes)))
			self.send_header("X-Tts-Cache", "hit" if cached is not None else "miss")
			self.end_headers()
			self.wfile.write(wav_bytes)
		except Exception as exc:  # noqa: BLE001
			self._json(500, {"error": f"{type(exc).__name__}: {exc}"})


def main() -> int:
	parser = argparse.ArgumentParser()
	parser.add_argument("--refs", required=True, help="参考音色目录")
	args = parser.parse_args()
	refs_dir = Path(args.refs).expanduser()
	refs_dir.mkdir(parents=True, exist_ok=True)

	Handler.refs_dir = refs_dir
	Handler.engine = TtsEngine()
	server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
	print(f"PORT={server.server_address[1]}", flush=True)
	try:
		server.serve_forever()
	except KeyboardInterrupt:
		pass
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
