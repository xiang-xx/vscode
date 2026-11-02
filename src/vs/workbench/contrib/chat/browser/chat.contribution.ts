/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { ExportAgentHostDebugLogsAction } from './actions/exportAgentHostDebugLogsAction.js';
import { ForkConversationAction } from './actions/chatForkActions.js';
import { ContinueChatInCopilotAction } from './actions/chatContinueInAction.js';
import { IChatResponseFileChangesService } from './chatResponseFileChangesService.js';
import { EditorChatResponseFileChangesService } from './editorChatResponseFileChangesService.js';
import { IAgentHostPolicyContinuationPresenter } from './agentSessions/agentHost/agentHostPolicyContinuation.js';
import { EditorAgentHostPolicyContinuationPresenter } from './agentSessions/agentHost/agentHostPolicyContinuationEditor.js';
import { IChatRouterService } from '../common/superAgent/chatRouterService.js';
import { ISuperAgentPresentationQueue } from '../common/superAgent/superAgentPresentationQueue.js';
import { ChatRouterService } from './superAgent/chatRouterServiceImpl.js';
import { SuperAgentChatBridge } from './superAgent/superAgentChatBridge.js';
import { SuperAgentEditorCoordinator } from './superAgent/superAgentEditorCoordinator.js';
import { SuperAgentChatPageContribution } from './superAgent/superAgentChatPage.js';
import { SuperAgentPresentationQueue } from './superAgent/superAgentPresentationQueueImpl.js';
import { SuperAgentPresentationUiContribution } from './superAgent/superAgentPresentationUi.js';
import { SuperAgentRouterDispatcher } from './superAgent/superAgentRouterDispatcher.js';

registerAction2(ForkConversationAction);
registerAction2(ContinueChatInCopilotAction);
registerAction2(ExportAgentHostDebugLogsAction);
registerSingleton(IChatResponseFileChangesService, EditorChatResponseFileChangesService, InstantiationType.Delayed);
registerSingleton(IAgentHostPolicyContinuationPresenter, EditorAgentHostPolicyContinuationPresenter, InstantiationType.Delayed);

// Super-Agent (Router + Worker) architecture — see superAgentRedesign.md
registerSingleton(IChatRouterService, ChatRouterService, InstantiationType.Delayed);
registerSingleton(ISuperAgentPresentationQueue, SuperAgentPresentationQueue, InstantiationType.Delayed);
registerWorkbenchContribution2(SuperAgentEditorCoordinator.ID, SuperAgentEditorCoordinator, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(SuperAgentRouterDispatcher.ID, SuperAgentRouterDispatcher, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(SuperAgentChatPageContribution.ID, SuperAgentChatPageContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(SuperAgentPresentationUiContribution.ID, SuperAgentPresentationUiContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(SuperAgentChatBridge.ID, SuperAgentChatBridge, WorkbenchPhase.AfterRestored);

