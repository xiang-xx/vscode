/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { projectInstructionsPath, zcodeHomeDir } from './userInstructions';

const SKILL_FILE = 'SKILL.md';
const MAX_SCAN_DEPTH = 4;
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_DESCRIPTION_CHARS = 1024;
const MAX_BODY_CHARS = 48 * 1024;
const MAX_CATALOG = 40;
const EXCLUDED_DIRS = new Set([
	'node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage',
	'.cache', '.next', '.turbo', '.venv', '__pycache__',
]);

export interface SkillSummary {
	name: string;
	description: string;
	scope: 'workspace' | 'user';
	filePath: string;
}

export interface PreparedComposerTurn {
	displayText: string;
	/** Omitted when the composer command is answered in the panel. */
	modelText?: string;
	notice?: string;
}

let skillListCache: { at: number; key: string; skills: SkillSummary[] } | undefined;

export function listLocalSkills(workspaceRoot?: string): SkillSummary[] {
	const key = workspaceRoot ?? '';
	const now = Date.now();
	if (skillListCache && skillListCache.key === key && now - skillListCache.at < 3000) {
		return skillListCache.skills;
	}
	const skills = discoverSkills(workspaceRoot);
	skillListCache = { at: now, key, skills };
	return skills;
}

function discoverSkills(workspaceRoot?: string): SkillSummary[] {
	const found = new Map<string, SkillSummary>();
	const absorb = (root: string | undefined, scope: SkillSummary['scope']) => {
		if (!root) {
			return;
		}
		for (const filePath of scanSkillFiles(root)) {
			const parsed = readSkillFile(filePath);
			if (!parsed) {
				continue;
			}
			const key = parsed.name.toLowerCase();
			if (found.has(key)) {
				continue;
			}
			found.set(key, {
				name: parsed.name,
				description: parsed.description,
				scope,
				filePath,
			});
		}
	};

	if (workspaceRoot) {
		for (const dir of ancestorDirs(workspaceRoot)) {
			absorb(path.join(dir, '.zcode', 'skills'), 'workspace');
			absorb(path.join(dir, '.agents', 'skills'), 'workspace');
		}
	}
	const home = zcodeHomeDir();
	absorb(path.join(home, '.zcode', 'skills'), 'user');
	absorb(path.join(home, '.agents', 'skills'), 'user');
	return [...found.values()];
}

export function formatSkillCatalog(skills: SkillSummary[]): string {
	if (!skills.length) {
		return '';
	}
	const lines = skills.slice(0, MAX_CATALOG).map(skill => {
		const description = skill.description.replace(/\s+/g, ' ').slice(0, 240);
		return `- ${skill.name}: ${description || '（无说明）'} (${skill.scope})`;
	});
	return [
		'<available-skills>',
		'Skill bodies are not included. Follow a skill only after the user activates it with $name or /skill name, and then use the activated-skill block in that message.',
		...lines,
		skills.length > MAX_CATALOG ? `- …${skills.length - MAX_CATALOG} more` : '',
		'</available-skills>',
	].filter(Boolean).join('\n');
}

/** Rewrite /init, /skill, and $skill mentions. Display text stays what the user typed. */
export function prepareComposerTurn(text: string, workspaceRoot?: string): PreparedComposerTurn {
	const displayText = text.trim();
	const init = /^\/init(?:\s+([\s\S]*))?$/.exec(displayText);
	if (init) {
		const notes = (init[1] ?? '').trim();
		const target = workspaceRoot
			? projectInstructionsPath(workspaceRoot)
			: 'AGENTS.md at the workspace root';
		const modelText = [
			`Create or update ${target}.`,
			'Read the repository enough to write accurate build, test, and convention notes.',
			'Keep the file concise. If it already exists, update it instead of dropping useful rules.',
			notes ? `User notes: ${notes}` : '',
		].filter(Boolean).join('\n');
		return { displayText, modelText };
	}

	const skillCmd = /^\/skill(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(displayText);
	if (skillCmd) {
		const skills = listLocalSkills(workspaceRoot);
		const rawName = (skillCmd[1] ?? '').replace(/^\$/, '');
		if (!rawName) {
			return { displayText, notice: formatSkillList(skills) };
		}
		const match = skills.find(skill => skill.name.toLowerCase() === rawName.toLowerCase());
		if (!match) {
			return { displayText, notice: `没有名为「${rawName}」的技能。输入 $ 可以挑选，或发送 /skill 查看列表。` };
		}
		const rest = (skillCmd[2] ?? '').trim();
		return { displayText, modelText: activateSkills([match], rest || displayText) };
	}

	const skills = listLocalSkills(workspaceRoot);
	const activated: SkillSummary[] = [];
	const seen = new Set<string>();
	for (const match of displayText.matchAll(/(^|[^A-Za-z0-9._-])\$([A-Za-z0-9][A-Za-z0-9._-]*)/g)) {
		const name = match[2];
		if (!name) {
			continue;
		}
		const skill = skills.find(item => item.name.toLowerCase() === name.toLowerCase());
		if (!skill || seen.has(skill.name.toLowerCase())) {
			continue;
		}
		seen.add(skill.name.toLowerCase());
		activated.push(skill);
	}
	if (!activated.length) {
		return { displayText, modelText: displayText };
	}
	return { displayText, modelText: activateSkills(activated, displayText) };
}

export function filterSkills(skills: SkillSummary[], query: string): SkillSummary[] {
	const q = query.trim().toLowerCase();
	const matched = !q
		? skills
		: skills.filter(skill =>
			skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q));
	return matched.slice(0, 12);
}

function activateSkills(skills: SkillSummary[], userText: string): string {
	const blocks = skills.map(skill => {
		const body = loadSkillBody(skill.filePath);
		return `<activated-skill name="${skill.name}" path="${skill.filePath}">\n${body}\n</activated-skill>`;
	});
	return `${blocks.join('\n\n')}\n\n${userText}`;
}

function formatSkillList(skills: SkillSummary[]): string {
	if (!skills.length) {
		return '还没有可用技能。个人技能放在 ~/.zcode/skills/<名字>/SKILL.md，项目技能放在 .zcode/skills/<名字>/SKILL.md。';
	}
	const lines = skills.slice(0, 30).map(skill => {
		const where = skill.scope === 'workspace' ? '项目' : '个人';
		const description = skill.description.replace(/\s+/g, ' ').slice(0, 120);
		return `- ${skill.name}（${where}）${description ? ` — ${description}` : ''}`;
	});
	if (skills.length > 30) {
		lines.push(`- …还有 ${skills.length - 30} 个`);
	}
	return `可用技能：\n${lines.join('\n')}\n输入 $名字 或 /skill 名字 把技能带进这一轮。`;
}

function loadSkillBody(filePath: string): string {
	const parsed = readSkillFile(filePath);
	if (!parsed) {
		return '(skill file could not be read)';
	}
	if (parsed.truncated) {
		return `${parsed.body}\n\n[Skill truncated]`;
	}
	return parsed.body || '(empty skill)';
}

interface ParsedSkill {
	name: string;
	description: string;
	body: string;
	truncated: boolean;
}

function readSkillFile(filePath: string): ParsedSkill | undefined {
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SKILL_FILE_BYTES) {
			return undefined;
		}
		const raw = fs.readFileSync(filePath, 'utf8');
		const parsed = splitFrontmatter(raw);
		const fallback = path.basename(path.dirname(filePath));
		const name = sanitizeSkillName(parsed.name) || sanitizeSkillName(fallback);
		if (!name) {
			return undefined;
		}
		let body = parsed.body.trim();
		let truncated = false;
		if (body.length > MAX_BODY_CHARS) {
			body = body.slice(0, MAX_BODY_CHARS).replace(/\uFFFD+$/, '');
			truncated = true;
		}
		const description = (parsed.description || '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION_CHARS);
		return { name, description, body, truncated };
	} catch {
		return undefined;
	}
}

function sanitizeSkillName(name: string | undefined): string {
	const trimmed = (name ?? '').trim();
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed) ? trimmed : '';
}

function splitFrontmatter(raw: string): { name?: string; description?: string; body: string } {
	const text = raw.replace(/^\uFEFF/, '');
	if (!text.startsWith('---')) {
		return { body: text };
	}
	const end = text.indexOf('\n---', 3);
	if (end < 0) {
		return { body: text };
	}
	const yaml = text.slice(3, end);
	const body = text.slice(end + 4).replace(/^\r?\n/, '');
	return {
		name: readYamlField(yaml, 'name'),
		description: readYamlField(yaml, 'description'),
		body,
	};
}

function readYamlField(yaml: string, key: string): string | undefined {
	const lines = yaml.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const match = new RegExp(`^${key}:\\s*(.*)$`).exec(lines[i] ?? '');
		if (!match) {
			continue;
		}
		const inline = unquote((match[1] ?? '').trim());
		if (inline && inline !== '>' && inline !== '|' && inline !== '>-' && inline !== '|-') {
			return inline;
		}
		const parts: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const line = lines[j] ?? '';
			if (!/^\s+\S/.test(line)) {
				break;
			}
			parts.push(line.trim());
		}
		const joined = parts.join(inline.startsWith('|') ? '\n' : ' ').trim();
		return joined || undefined;
	}
	return undefined;
}

function unquote(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"') && value.length >= 2)
		|| (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
	) {
		return value.slice(1, -1);
	}
	return value;
}

function scanSkillFiles(root: string): string[] {
	if (!fs.existsSync(root)) {
		return [];
	}
	const out: string[] = [];
	walkSkills(root, 0, out, new Set());
	return out;
}

function walkSkills(dir: string, depth: number, out: string[], seen: Set<string>): void {
	let real: string;
	try {
		real = fs.realpathSync(dir);
	} catch {
		return;
	}
	if (seen.has(real)) {
		return;
	}
	seen.add(real);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	if (entries.some(entry => entry.name === SKILL_FILE && !entry.isDirectory())) {
		out.push(path.join(dir, SKILL_FILE));
		return;
	}
	if (depth >= MAX_SCAN_DEPTH) {
		return;
	}
	for (const entry of entries) {
		if (!shouldWalk(entry.name)) {
			continue;
		}
		if (entry.isDirectory() || entry.isSymbolicLink()) {
			walkSkills(path.join(dir, entry.name), depth + 1, out, seen);
		}
	}
}

function shouldWalk(name: string): boolean {
	if (EXCLUDED_DIRS.has(name)) {
		return false;
	}
	if (name.startsWith('.') && name !== '.system') {
		return false;
	}
	return true;
}

function ancestorDirs(start: string): string[] {
	const dirs: string[] = [];
	let current = path.resolve(start);
	let probe = current;
	let gitRoot: string | undefined;
	for (let i = 0; i < 32; i++) {
		if (fs.existsSync(path.join(probe, '.git'))) {
			gitRoot = probe;
			break;
		}
		const parent = path.dirname(probe);
		if (parent === probe) {
			break;
		}
		probe = parent;
	}
	const stop = gitRoot ?? current;
	for (let i = 0; i < 32; i++) {
		dirs.push(current);
		if (current === stop) {
			break;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	return dirs;
}
