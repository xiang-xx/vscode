#!/usr/bin/env bash
# Build this checkout and install or update "Code - OSS" in /Applications.
# Also points `code` / `code-oss` at the installed app CLI.
# Usage: ./scripts/install-macos.sh [--no-open]

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
	echo "这个脚本只用于 macOS。" >&2
	exit 1
fi

OPEN_AFTER=1
if [[ "${1:-}" == "--no-open" ]]; then
	OPEN_AFTER=0
elif [[ -n "${1:-}" ]]; then
	echo "用法: ./scripts/install-macos.sh [--no-open]" >&2
	exit 1
fi

case "$(uname -m)" in
	arm64) TARGET=darwin-arm64 ;;
	x86_64) TARGET=darwin-x64 ;;
	*)
		echo "不支持的架构: $(uname -m)" >&2
		exit 1
		;;
esac

if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
	# shellcheck disable=SC1091
	. "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
	nvm use
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

APP_NAME=$(node -p "require('./product.json').nameLong")
APP_BIN_NAME=$(node -p "require('./product.json').applicationName")
APP_BUNDLE="${APP_NAME}.app"
BUILT="${ROOT}/../VSCode-${TARGET}/${APP_BUNDLE}"
DEST="/Applications/${APP_BUNDLE}"

# Fail fast if packaging corrupted app/package.json (e.g. overwritten by dependency "ws").
assert_app_package_json() {
	local app_root="$1"
	local pkg="${app_root}/Contents/Resources/app/package.json"
	local cli="${app_root}/Contents/Resources/app/bin/code"

	if [[ ! -f "$pkg" ]]; then
		echo "缺少 ${pkg}" >&2
		exit 1
	fi
	if [[ ! -x "$cli" ]]; then
		echo "缺少可执行 CLI: ${cli}" >&2
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

link_cli() {
	local cli="$1/Contents/Resources/app/bin/code"
	local dir=""
	local use_sudo=0

	if [[ -d /usr/local/bin ]]; then
		dir=/usr/local/bin
		if [[ ! -w "$dir" ]]; then
			use_sudo=1
		fi
	elif mkdir -p "${HOME}/.local/bin" 2>/dev/null; then
		dir="${HOME}/.local/bin"
	else
		echo "无法写入 CLI 目录，跳过 code / ${APP_BIN_NAME} 链接。" >&2
		return 0
	fi

	if [[ "$use_sudo" == "1" ]]; then
		echo "更新 ${dir}/code 需要管理员权限…"
		sudo ln -sf "$cli" "${dir}/code"
		sudo ln -sf "$cli" "${dir}/${APP_BIN_NAME}"
	else
		ln -sf "$cli" "${dir}/code"
		ln -sf "$cli" "${dir}/${APP_BIN_NAME}"
	fi
	echo "已链接 ${dir}/code 和 ${dir}/${APP_BIN_NAME} -> ${cli}"

	case ":${PATH}:" in
		*":${dir}:"*) ;;
		*)
			echo "注意: ${dir} 不在 PATH 里。把下面这行加进 shell 配置后重开终端：" >&2
			echo "  export PATH=\"${dir}:\$PATH\"" >&2
			;;
	esac
}

echo "编译 ${TARGET} …"
npm run gulp "vscode-${TARGET}"

if [[ ! -d "$BUILT" ]]; then
	echo "没找到打包结果: ${BUILT}" >&2
	exit 1
fi

assert_app_package_json "$BUILT"

if pgrep -xq "$APP_NAME"; then
	echo "退出正在运行的 ${APP_NAME} …"
	osascript -e "quit app \"${APP_NAME}\"" || true
	for _ in $(seq 1 30); do
		if ! pgrep -xq "$APP_NAME"; then
			break
		fi
		sleep 1
	done
	if pgrep -xq "$APP_NAME"; then
		echo "${APP_NAME} 还在运行，先手动退出再安装。" >&2
		exit 1
	fi
fi

echo "安装到 ${DEST}"
rm -rf "$DEST"
ditto "$BUILT" "$DEST"
xattr -dr com.apple.quarantine "$DEST" || true

assert_app_package_json "$DEST"
link_cli "$DEST"

echo "已安装 ${DEST}"
if [[ "$OPEN_AFTER" == "1" ]]; then
	open -a "$DEST"
fi
