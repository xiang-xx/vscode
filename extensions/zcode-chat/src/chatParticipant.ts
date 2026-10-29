/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { completeChatTurn, workspaceRoot, type ChatMessage } from './bridge';
import { getFileEditSession } from './fileEditSession';
import {
	ensureModelForProvider,
	ensureReasoningLevelForModel,
	getSelectedModelId,
	getSelectedReasoningLevel,
	pickModel,
	pickReasoningLevel,
	setSelectedModelId,
	setSelectedReasoningLevel,
} from './models';
import { getProviderMode, pickProviderMode, PROVIDER_LABELS, setProviderMode } from './providers';

type ChatResponseStreamEx = vscode.ChatResponseStream & {
	externalEdit?(target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>): Thenable<string>;
};

export function registerChatParticipant(context: vscode.ExtensionContext): void {
	const participant = vscode.chat.createChatParticipant('zcode.chat', async (request, chatContext, response, token) => {
		if (request.command === 'provider') {
			const next = await pickProviderMode();
			if (next) {
				await setProviderMode(next);
				const modelId = await ensureModelForProvider(next);
				await ensureReasoningLevelForModel(next, modelId);
				response.markdown(`Provider switched to **${PROVIDER_LABELS[next]}**.`);
			} else {
				response.markdown(`Current provider: **${PROVIDER_LABELS[getProviderMode()]}**.`);
			}
			return {};
		}

		const provider = getProviderMode();
		const model = getSelectedModelId(provider);
		const reasoningLevel = getSelectedReasoningLevel(provider, model);
		response.markdown(`_ZCode · ${PROVIDER_LABELS[provider]} · ${model} · thinking ${reasoningLevel}_`);
		response.markdown('\n\n');

		const history = historyToMessages(chatContext);
		const messages: ChatMessage[] = [
			...history,
			{ role: 'user', content: request.prompt },
		];

		const stream = response as ChatResponseStreamEx;
		const root = workspaceRoot();

		try {
			const run = () => completeChatTurn({
				messages,
				provider,
				model,
				reasoningLevel,
				workspaceRoot: root,
				onProgress: event => {
					if (event.type === 'status') {
						response.progress(event.text);
					}
				},
			}, token);

			// When proposed chatParticipantAdditions is available, attribute disk
			// writes as chat agent edits so the built-in Keep/Undo UI can attach.
			let result;
			if (typeof stream.externalEdit === 'function' && root) {
				await stream.externalEdit(vscode.Uri.file(root), async () => {
					result = await run();
				});
			} else {
				result = await run();
			}

			if (token.isCancellationRequested) {
				return {};
			}

			response.markdown(result!.content);
			const changes = getFileEditSession().list();
			if (changes.length) {
				response.markdown(`\n\n_${changes.length} file(s) changed — review in the editor (Keep / Undo) or the ZCode working set._`);
			}

			return {
				metadata: {
					provider: result!.provider,
					bridgeMode: result!.bridgeMode,
					stub: !!result!.stub,
					model,
					reasoningLevel,
					fileChanges: changes.length,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			response.markdown(`ZCode bridge error: ${message}`);
			return { errorDetails: { message } };
		}
	});

	participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
	context.subscriptions.push(participant);
}

export async function switchModelCommand(): Promise<void> {
	const provider = getProviderMode();
	const next = await pickModel(provider);
	if (!next) {
		return;
	}
	await setSelectedModelId(next);
	await ensureReasoningLevelForModel(provider, next);
}

export async function switchReasoningLevelCommand(): Promise<void> {
	const provider = getProviderMode();
	const next = await pickReasoningLevel(provider);
	if (!next) {
		return;
	}
	await setSelectedReasoningLevel(next);
}

function historyToMessages(chatContext: vscode.ChatContext): ChatMessage[] {
	const messages: ChatMessage[] = [];
	for (const turn of chatContext.history) {
		if (turn instanceof vscode.ChatRequestTurn) {
			messages.push({ role: 'user', content: turn.prompt });
			continue;
		}
		if (turn instanceof vscode.ChatResponseTurn) {
			const parts: string[] = [];
			for (const part of turn.response) {
				if (part instanceof vscode.ChatResponseMarkdownPart) {
					parts.push(part.value.value);
				}
			}
			const content = parts.join('\n').trim();
			if (content) {
				messages.push({ role: 'assistant', content });
			}
		}
	}
	return messages;
}
