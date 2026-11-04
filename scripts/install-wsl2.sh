#!/usr/bin/env bash
# Build this checkout and install or update Code - OSS inside WSL2.
# Also points `code` / `code-oss` at the installed Linux CLI (with WSL prompt suppressed).
# Usage: ./scripts/install-wsl2.sh [--no-open] [--system]
#
# Default install: ~/.local/opt/VSCode-linux-<arch>
# --system:        /opt/VSCode-linux-<arch> (needs sudo)

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

if ! grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
	echo "这个脚本只用于 WSL2。" >&2
	exit 1
fi

OPEN_AFTER=1
SYSTEM_INSTALL=0
for arg in "$@"; do
	case "$arg" in
		--no-open) OPEN_AFTER=0 ;;
		--system) SYSTEM_INSTALL=1 ;;
		-h | --help)
			echo "用法: ./scripts/install-wsl2.sh [--no-open] [--system]"
			exit 0
			;;
		*)
			echo "用法: ./scripts/install-wsl2.sh [--no-open] [--system]" >&2
			exit 1
			;;
	esac
done

case "$(uname -m)" in
	x86_64 | amd64) ARCH=x64 ;;
	aarch64 | arm64) ARCH=arm64 ;;
	*)
		echo "不支持的架构: $(uname -m)" >&2
		exit 1
		;;
esac

TARGET="linux-${ARCH}"

if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
	# shellcheck disable=SC1091
	. "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
	# nodejs.org 在部分网络下不可达，回退到 npmmirror。
	if [[ -z "${NVM_NODEJS_ORG_MIRROR:-}" ]] && ! curl -fsI --max-time 5 https://nodejs.org/dist/ >/dev/null 2>&1; then
		export NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node
		echo "nodejs.org 不可达，改用镜像: ${NVM_NODEJS_ORG_MIRROR}"
	fi
	if ! nvm use; then
		echo "按 .nvmrc 安装 Node …"
		nvm install
		nvm use
	fi
	cd "$ROOT"
fi

REQUIRED=$(tr -d '[:space:]' < .nvmrc)
REQUIRED_MAJOR=${REQUIRED%%.*}
CURRENT=$(node -p "process.versions.node")
CURRENT_MAJOR=${CURRENT%%.*}
if [[ "$CURRENT_MAJOR" != "$REQUIRED_MAJOR" ]]; then
	echo "需要 Node ${REQUIRED}（.nvmrc），当前是 v${CURRENT}。" >&2
	echo "先执行: nvm install && nvm use" >&2
	exit 1
fi

# 国内网络：npm / Electron / GitHub API 常慢或失败，默认走 npmmirror（仅影响本进程）。
if [[ -z "${npm_config_registry:-}" ]]; then
	export npm_config_registry=https://registry.npmmirror.com
	echo "npm 源: ${npm_config_registry}"
fi
# Electron / Node headers：预置到 node-gyp 缓存（勿设全局 npm_config_nodedir，否则 build/ 会误用 Electron headers）。
seed_node_gyp_headers() {
	local ver="$1" url="$2" layout="$3"
	local cache="${HOME}/.cache/node-gyp/${ver}"
	[[ -f "${cache}/include/node/common.gypi" ]] && return 0
	echo "预置 headers ${ver} …"
	local tmp
	tmp=$(mktemp -d)
	curl -fsSL --max-time 180 -o "${tmp}/headers.tgz" "$url"
	tar -xzf "${tmp}/headers.tgz" -C "${tmp}"
	rm -rf "${cache}"
	mkdir -p "${cache}"
	if [[ "$layout" == "electron" ]]; then
		mv "${tmp}/node_headers/include" "${cache}/include"
	else
		mv "${tmp}/node-v${ver}/include" "${cache}/include"
	fi
	echo 11 >"${cache}/installVersion"
	rm -rf "${tmp}"
}
ELECTRON_HEADERS_VER=$(grep -E '^target=' .npmrc | cut -d= -f2 | tr -d '"' || true)
if [[ -n "${ELECTRON_HEADERS_VER}" ]]; then
	seed_node_gyp_headers "${ELECTRON_HEADERS_VER}" \
		"https://cdn.npmmirror.com/binaries/electron/v${ELECTRON_HEADERS_VER}/node-v${ELECTRON_HEADERS_VER}-headers.tar.gz" \
		electron
fi
NODE_HEADERS_VER=$(grep -E '^target=' remote/.npmrc | cut -d= -f2 | tr -d '"' || true)
if [[ -n "${NODE_HEADERS_VER}" ]]; then
	seed_node_gyp_headers "${NODE_HEADERS_VER}" \
		"https://cdn.npmmirror.com/binaries/node/v${NODE_HEADERS_VER}/node-v${NODE_HEADERS_VER}-headers.tar.gz" \
		node
fi
if [[ -z "${ELECTRON_MIRROR:-}" ]]; then
	export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
fi
# @vscode/ripgrep 走 GitHub API，易 403；预置二进制缓存。
seed_ripgrep_cache() {
	local rg_ver asset cache
	rg_ver=$(node -p "require('./package-lock.json').packages['node_modules/@vscode/ripgrep']?.version || ''" 2>/dev/null || true)
	[[ -z "$rg_ver" ]] && return 0
	# 与 @vscode/ripgrep@1.17.x 内置 VERSION 对齐；若升级后失败再调。
	asset="ripgrep-v15.0.1-x86_64-unknown-linux-musl.tar.gz"
	case "$(uname -m)" in
		aarch64 | arm64) asset="ripgrep-v15.0.1-aarch64-unknown-linux-musl.tar.gz" ;;
	esac
	cache="/tmp/vscode-ripgrep-cache-${rg_ver}"
	mkdir -p "$cache"
	if [[ ! -s "${cache}/${asset}" ]]; then
		echo "预置 ripgrep 二进制 …"
		curl -fsSL --max-time 120 -o "${cache}/${asset}" "https://cdn.npmmirror.com/binaries/ripgrep-prebuilt/v15.0.1/${asset}" || true
	fi
}
seed_ripgrep_cache

APP_NAME=$(node -p "require('./product.json').nameLong")
APP_BIN_NAME=$(node -p "require('./product.json').applicationName")
BUILT="${ROOT}/../VSCode-${TARGET}"
if [[ "$SYSTEM_INSTALL" == "1" ]]; then
	DEST="/opt/VSCode-${TARGET}"
else
	DEST="${HOME}/.local/opt/VSCode-${TARGET}"
fi

assert_app_package_json() {
	local app_root="$1"
	local pkg="${app_root}/resources/app/package.json"
	local cli="${app_root}/bin/${APP_BIN_NAME}"
	local electron="${app_root}/${APP_BIN_NAME}"

	if [[ ! -f "$pkg" ]]; then
		echo "缺少 ${pkg}" >&2
		exit 1
	fi
	if [[ ! -x "$cli" ]]; then
		echo "缺少可执行 CLI: ${cli}" >&2
		exit 1
	fi
	if [[ ! -x "$electron" ]]; then
		echo "缺少 Electron 可执行文件: ${electron}" >&2
		exit 1
	fi

	node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const name = pkg.name || '';
const main = pkg.main || '';
if (name === 'ws' || main !== './out/main.js') {
	console.error('打包结果异常: ' + process.argv[1]);
	console.error('  name=' + JSON.stringify(name) + ' main=' + JSON.stringify(main));
	console.error('  期望 name 不是 \"ws\"，且 main 为 \"./out/main.js\"。');
	process.exit(1);
}
" "$pkg"
}

write_cli_wrapper() {
	local target="$1"
	local cli="$2"
	cat >"$target" <<EOF
#!/usr/bin/env bash
# Generated by scripts/install-wsl2.sh — launches the WSL-installed ${APP_NAME} CLI.
export DONT_PROMPT_WSL_INSTALL=1
exec "$(realpath "$cli")" "\$@"
EOF
	chmod +x "$target"
}

link_cli() {
	local cli="$1/bin/${APP_BIN_NAME}"
	local dir="${HOME}/.local/bin"

	mkdir -p "$dir"
	write_cli_wrapper "${dir}/code" "$cli"
	write_cli_wrapper "${dir}/${APP_BIN_NAME}" "$cli"
	echo "已写入 ${dir}/code 和 ${dir}/${APP_BIN_NAME} -> ${cli}"

	case ":${PATH}:" in
		*":${dir}:"*) ;;
		*)
			echo "注意: ${dir} 不在 PATH 里。把下面这行加进 ~/.zshrc / ~/.bashrc 后重开终端：" >&2
			echo "  export PATH=\"${dir}:\$PATH\"" >&2
			;;
	esac

	# Warn if Windows VS Code's code.exe still wins on PATH.
	local first
	first=$(command -v code 2>/dev/null || true)
	if [[ -n "$first" && "$first" != "${dir}/code" ]]; then
		echo "注意: 当前 which code => ${first}" >&2
		echo "  若要优先用魔改版，确保 ${dir} 排在 Windows 的 code 路径前面，然后执行: hash -r" >&2
	fi
}

stop_running() {
	# Match Electron binary under the install/build dirs.
	local patterns=("${DEST}/${APP_BIN_NAME}" "${BUILT}/${APP_BIN_NAME}")
	local found=0
	for p in "${patterns[@]}"; do
		if pgrep -f "$p" >/dev/null 2>&1; then
			found=1
			echo "退出正在运行的 ${APP_NAME}（${p}）…"
			pkill -f "$p" || true
		fi
	done
	if [[ "$found" == "0" ]]; then
		return 0
	fi
	for _ in $(seq 1 30); do
		if ! pgrep -f "${DEST}/${APP_BIN_NAME}" >/dev/null 2>&1 && ! pgrep -f "${BUILT}/${APP_BIN_NAME}" >/dev/null 2>&1; then
			return 0
		fi
		sleep 1
	done
	echo "${APP_NAME} 还在运行，先手动退出再安装。" >&2
	exit 1
}

if [[ ! -d node_modules ]]; then
	echo "未找到 node_modules，先执行 npm install …"
	npm install
fi

echo "编译 ${TARGET} …"
npm run gulp "vscode-${TARGET}"

if [[ ! -d "$BUILT" ]]; then
	echo "没找到打包结果: ${BUILT}" >&2
	exit 1
fi

assert_app_package_json "$BUILT"
stop_running

echo "安装到 ${DEST}"
if [[ "$SYSTEM_INSTALL" == "1" ]]; then
	sudo mkdir -p "$(dirname "$DEST")"
	sudo rm -rf "$DEST"
	sudo cp -a "$BUILT" "$DEST"
	sudo chown -R root:root "$DEST"
else
	mkdir -p "$(dirname "$DEST")"
	rm -rf "$DEST"
	cp -a "$BUILT" "$DEST"
fi

assert_app_package_json "$DEST"
link_cli "$DEST"

echo "已安装 ${DEST}"
echo "可用: code .   或   ${APP_BIN_NAME} ."
echo "可通过 /mnt/c/... 打开 Windows 盘上的文件（WSLg 下以 Linux GUI 运行）。"
echo "这不会安装到 Windows 本机；开始菜单 / 资源管理器右键仍是原 Windows VS Code。"

if [[ "$OPEN_AFTER" == "1" ]]; then
	if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
		echo "未检测到 DISPLAY/WAYLAND_DISPLAY，跳过自动打开（可手动: code）。" >&2
	else
		DONT_PROMPT_WSL_INSTALL=1 "${DEST}/bin/${APP_BIN_NAME}" >/dev/null 2>&1 &
		disown || true
	fi
fi
