/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Bridges ZCode agent writes into Chat's review pipeline
 * (ChatEditingModifiedDocumentEntry → editor overlay Keep/Undo + line markers).
 *
 * Pattern mirrors AgentHostEditReview: seed a document entry from a baseline
 * snapshot, force the live model to the new content, enable review mode, then
 * wait for a real diff before revealing the editor.
 */

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { autorun, constObservable, IObservable, IReader, ITransaction, observableValue, transaction } from '../../../../../base/common/observable.js';
import { dirname, isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { OffsetRange } from '../../../../../editor/common/core/ranges/offsetRange.js';
import { StringEdit } from '../../../../../editor/common/core/edits/stringEdit.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { TextEdit } from '../../../../../editor/common/languages.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ChatEditKind, IChatEditReviewSession, IChatEditingService, IModifiedEntryTelemetryInfo, IModifiedFileEntry, ModifiedFileEntryState } from '../../common/editing/chatEditingService.js';
import { ChatEditingModifiedDocumentEntry } from '../chatEditing/chatEditingModifiedDocumentEntry.js';

export const ZCODE_EDITING_APPLY_COMMAND = '_zcode.editing.applyEdit';
export const ZCODE_EDITING_SYNC_COMMAND = '_zcode.editing.sync';
export const ZCODE_EDITING_CLEAR_COMMAND = '_zcode.editing.clear';
export const ZCODE_EDITING_STATUS_COMMAND = '_zcode.editing.status';
/** Fired to the extension when a hunk/file Keep or Undo settles an entry. */
export const ZCODE_EDITING_SETTLED_COMMAND = 'zcode.fileEdits.onSettled';

export interface IZcodeEditingFileDto {
	readonly uri: URI;
	readonly original: string;
	readonly kind?: 'create' | 'edit' | 'delete';
}

export interface IZcodeApplyEditDto {
	readonly uri: URI;
	readonly content: string;
	readonly original: string;
	readonly kind?: 'create' | 'edit' | 'delete';
	readonly reveal?: boolean;
}

const SESSION_RESOURCE = URI.parse('zcode-chat-session:global');

function fullReplaceEdit(model: ITextModel, content: string): TextEdit {
	const lastLine = model.getLineCount();
	const lastCol = model.getLineMaxColumn(lastLine);
	return { range: new Range(1, 1, lastLine, lastCol), text: content };
}

class ZCodeEditReviewEntry extends ChatEditingModifiedDocumentEntry {
	/** Expose protected helpers used by AgentHost-style review setup. */
	seedMapping(edit: StringEdit): void {
		this._mapOriginalToModified(edit);
	}

	async forceOriginal(content: string): Promise<void> {
		await this._resetOriginalContent(content);
	}
}

class ZCodeEditReviewSession extends Disposable implements IChatEditReviewSession {

	readonly isGlobalEditingSession = constObservable(true);
	readonly chatSessionResource = SESSION_RESOURCE;

	private readonly _onDidDispose = this._register(new Emitter<void>());
	readonly onDidDispose: Event<void> = this._onDidDispose.event;

	private readonly _entriesObs = observableValue<readonly ZCodeEditReviewEntry[]>(this, []);
	readonly entries: IObservable<readonly IModifiedFileEntry[]> = this._entriesObs;

	private readonly _entryStores = new ResourceMap<DisposableStore>();

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IFileService private readonly _fileService: IFileService,
		@ICommandService private readonly _commandService: ICommandService,
		@IEditorService private readonly _editorService: IEditorService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(toDisposable(() => {
			for (const store of this._entryStores.values()) {
				store.dispose();
			}
			this._entryStores.clear();
			this._entriesObs.set([], undefined);
			this._onDidDispose.fire();
		}));
	}

	getEntry(uri: URI): IModifiedFileEntry | undefined {
		return this._entriesObs.get().find(e => isEqual(e.modifiedURI, uri));
	}

	readEntry(uri: URI, reader: IReader): IModifiedFileEntry | undefined {
		return this._entriesObs.read(reader).find(e => isEqual(e.modifiedURI, uri));
	}

	status(): { entryCount: number; files: Array<{ uri: string; state: string; changes: number }> } {
		return {
			entryCount: this._entriesObs.get().length,
			files: this._entriesObs.get().map(e => ({
				uri: e.modifiedURI.toString(),
				state: String(e.state.get()),
				changes: e.changesCount.get(),
			})),
		};
	}

	async accept(...uris: URI[]): Promise<void> {
		const targets = uris.length ? uris : this._entriesObs.get().map(e => e.modifiedURI);
		for (const uri of targets) {
			const entry = this.getEntry(uri);
			if (entry && entry.state.get() === ModifiedFileEntryState.Modified) {
				await entry.accept();
			}
		}
	}

	async reject(...uris: URI[]): Promise<void> {
		const targets = uris.length ? uris : this._entriesObs.get().map(e => e.modifiedURI);
		for (const uri of targets) {
			const entry = this.getEntry(uri);
			if (entry && entry.state.get() === ModifiedFileEntryState.Modified) {
				await entry.reject();
			}
		}
	}

	async applyEdit(file: IZcodeApplyEditDto): Promise<{ changes: number }> {
		await this._ensureFileExists(file.uri, file.kind === 'create', file.original);

		// Make sure the text-file model is open and matches disk before review.
		await this._textFileService.files.resolve(file.uri, { reload: { async: false } }).catch(() => { /* brand-new files ok */ });

		let entry = this.getEntry(file.uri) as ZCodeEditReviewEntry | undefined;
		if (!entry) {
			entry = await this._addEntry({
				uri: file.uri,
				original: file.original,
				kind: file.kind,
			});
		}
		if (!entry) {
			throw new Error(`Failed to create review entry for ${file.uri.toString()}`);
		}

		entry.enableReviewModeUntilSettled();

		// Keep original snapshot pinned even if the model was already rewritten.
		if (entry.originalModel.getValue() !== file.original) {
			await entry.forceOriginal(file.original);
		}

		const model = entry.modifiedModel;
		if (model.getValue() !== file.content) {
			// Non-atomic: avoid the atomic-edit animation path (can fail headless).
			await entry.acceptAgentEdits(entry.modifiedURI, [fullReplaceEdit(model, file.content)], false, undefined, {});
			await entry.acceptAgentEdits(entry.modifiedURI, [], true, undefined, {});
		} else {
			const edit = StringEdit.replace(OffsetRange.ofLength(file.original.length), file.content)
				.removeCommonSuffixAndPrefix(file.original);
			entry.seedMapping(edit);
			await entry.getDiffInfo();
		}

		const diff = await entry.getDiffInfo();
		const changes = diff.changes.length;
		this._logService.info('[zcode editing] applied edit', file.uri.toString(), `changes=${changes}`, `identical=${diff.identical}`);

		if (file.reveal !== false) {
			await this._editorService.openEditor({
				resource: file.uri,
				options: { preserveFocus: true, pinned: true, revealIfOpened: true },
			});
			// Touch integration now that an editor pane exists.
			const pane = this._editorService.activeEditorPane;
			if (pane) {
				entry.getEditorIntegration(pane);
			}
		}

		return { changes };
	}

	async syncFiles(files: readonly IZcodeEditingFileDto[]): Promise<void> {
		const wanted = new ResourceMap<IZcodeEditingFileDto>();
		for (const file of files) {
			wanted.set(file.uri, file);
		}

		for (const entry of [...this._entriesObs.get()]) {
			if (!wanted.has(entry.modifiedURI)) {
				await this._removeEntry(entry.modifiedURI);
			}
		}

		for (const file of files) {
			if (this.getEntry(file.uri)) {
				continue;
			}
			try {
				await this._textFileService.files.resolve(file.uri, { reload: { async: false } }).catch(() => { /* ignore */ });
				const entry = await this._addEntry(file);
				entry?.enableReviewModeUntilSettled();
				await entry?.getDiffInfo();
				this._logService.info('[zcode editing] synced review entry', file.uri.toString(), `changes=${entry?.changesCount.get() ?? 0}`);
			} catch (err) {
				this._logService.error('[zcode editing] failed to create review entry', file.uri.toString(), err);
			}
		}
	}

	async clear(): Promise<void> {
		for (const entry of [...this._entriesObs.get()]) {
			await this._removeEntry(entry.modifiedURI);
		}
	}

	private async _ensureFileExists(uri: URI, isCreate: boolean, original: string): Promise<void> {
		if (await this._fileService.exists(uri)) {
			return;
		}
		void isCreate;
		try {
			await this._fileService.createFolder(dirname(uri));
		} catch {
			// parent may already exist
		}
		await this._fileService.writeFile(uri, VSBuffer.fromString(original || ''));
	}

	private async _addEntry(file: IZcodeEditingFileDto): Promise<ZCodeEditReviewEntry | undefined> {
		const existing = this.getEntry(file.uri) as ZCodeEditReviewEntry | undefined;
		if (existing) {
			return existing;
		}

		const telemetryInfo: IModifiedEntryTelemetryInfo = {
			agentId: 'zcode.chat',
			command: undefined,
			sessionResource: SESSION_RESOURCE,
			requestId: `zcode-${Date.now().toString(36)}`,
			result: undefined,
			modelId: undefined,
			modeId: 'agent',
			applyCodeBlockSuggestionId: undefined,
			feature: 'sideBarChat',
		};

		const kind = file.kind === 'create' ? ChatEditKind.Created : ChatEditKind.Modified;
		const ref = await this._textModelService.createModelReference(file.uri);
		const multiDiffEntryDelegate = {
			collapse: (_tx: ITransaction | undefined) => { /* no multi-diff list */ },
		};

		const entry = this._instantiationService.createInstance(
			ZCodeEditReviewEntry,
			ref,
			multiDiffEntryDelegate,
			telemetryInfo,
			kind,
			file.original,
		);
		entry.enableReviewModeUntilSettled();

		const store = new DisposableStore();
		this._entryStores.set(file.uri, store);
		store.add(entry);
		store.add(autorun(reader => {
			const state = entry.state.read(reader);
			if (state === ModifiedFileEntryState.Accepted || state === ModifiedFileEntryState.Rejected) {
				void this._commandService.executeCommand(ZCODE_EDITING_SETTLED_COMMAND, {
					uri: entry.modifiedURI,
					outcome: state === ModifiedFileEntryState.Accepted ? 'keep' : 'undo',
				}).then(undefined, () => { /* extension may not be ready */ });
				void this._removeEntry(entry.modifiedURI);
			}
		}));

		transaction(tx => {
			this._entriesObs.set([...this._entriesObs.get(), entry], tx);
		});
		return entry;
	}

	private async _removeEntry(uri: URI): Promise<void> {
		const store = this._entryStores.get(uri);
		if (store) {
			store.dispose();
			this._entryStores.delete(uri);
		}
		transaction(tx => {
			this._entriesObs.set(this._entriesObs.get().filter(e => !isEqual(e.modifiedURI, uri)), tx);
		});
	}
}

export class ZCodeChatEditingBridge implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.zcodeChatEditingBridge';

	private readonly _store = new DisposableStore();
	private readonly _registration = this._store.add(new MutableDisposable());
	private _session: ZCodeEditReviewSession | undefined;

	constructor(
		@IChatEditingService private readonly _chatEditingService: IChatEditingService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		this._store.add(CommandsRegistry.registerCommand(ZCODE_EDITING_APPLY_COMMAND, async (_accessor, dto?: {
			uri: URI;
			content: string;
			original: string;
			kind?: 'create' | 'edit' | 'delete';
			reveal?: boolean;
		}) => {
			try {
				if (!dto?.uri || typeof dto.content !== 'string' || typeof dto.original !== 'string') {
					throw new Error('_zcode.editing.applyEdit requires { uri, content, original }');
				}
				const session = this._ensureSession();
				return await session.applyEdit({
					uri: URI.revive(dto.uri),
					content: dto.content,
					original: dto.original,
					kind: dto.kind,
					reveal: dto.reveal,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this._logService.error('[zcode editing] applyEdit failed', message, err);
				this._notificationService.notify({
					severity: Severity.Warning,
					message: `ZCode editor markers failed: ${message}`,
				});
				throw err;
			}
		}));
		this._store.add(CommandsRegistry.registerCommand(ZCODE_EDITING_SYNC_COMMAND, async (_accessor, files?: Array<{ uri: URI; original: string; kind?: 'create' | 'edit' | 'delete' }>) => {
			const session = this._ensureSession();
			const revived = Array.isArray(files)
				? files.map(f => ({
					uri: URI.revive(f.uri),
					original: typeof f.original === 'string' ? f.original : '',
					kind: f.kind,
				}))
				: [];
			await session.syncFiles(revived);
		}));
		this._store.add(CommandsRegistry.registerCommand(ZCODE_EDITING_CLEAR_COMMAND, async () => {
			await this._session?.clear();
		}));
		this._store.add(CommandsRegistry.registerCommand(ZCODE_EDITING_STATUS_COMMAND, () => {
			return this._session?.status() ?? { entryCount: 0, files: [] };
		}));
	}

	private _ensureSession(): ZCodeEditReviewSession {
		if (!this._session) {
			this._session = this._instantiationService.createInstance(ZCodeEditReviewSession);
			this._registration.value = this._chatEditingService.registerEditReviewSession(this._session);
			this._logService.info('[zcode editing] review session registered (reuses Chat editing decorations)');
		}
		return this._session;
	}

	dispose(): void {
		void this._session?.clear();
		this._session?.dispose();
		this._session = undefined;
		this._store.dispose();
	}
}
