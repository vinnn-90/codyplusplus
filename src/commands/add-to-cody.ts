import * as path from 'path'
import * as vscode from 'vscode'
import { TELEMETRY_EVENTS } from '../constants/telemetry'
import { executeMentionFileCommand } from '../core/cody/commands'
import { formatFileTree, getWorkspaceFileTree } from '../core/filesystem/operations'
import { getSelectedFileUris, getSelectedFolderCount } from '../core/filesystem/processor'
import { createProvider } from '../core/llm'
import { createCompletionRequestMessages, parseLLMResponse } from '../core/llm/utils'
import { TelemetryService } from '../services/telemetry.service'
import { getSuccessCount } from '../utils'
import { getProviderConfig } from '../utils/workspace-config'
import { selectProvider } from './provider-commands'

let telemetryServiceInstance: TelemetryService | null = null

export async function addFile(folderUri: vscode.Uri) {
  const telemetry = TelemetryService.getInstance()
  try {
    const files = await getSelectedFileUris([folderUri])
    const fileCount = (await Promise.all(files.map(executeMentionFileCommand))).reduce(
      getSuccessCount,
      0
    )

    telemetry.trackEvent(TELEMETRY_EVENTS.FILES.ADD_FILE, {
      fileCount,
      folderCount: 1 // Single file operation always has 1 folder
    })
  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to add file to Cody: ${error.message}`)
  }
}

export async function addSelection(folderUris: vscode.Uri[], recursive = false) {
  const telemetry = TelemetryService.getInstance()
  try {
    const { folderCount, fileUris } = await getSelectedFolderCount(folderUris, {
      recursive,
      progressTitle: 'Adding selection to Cody'
    })

    const fileCount = (await Promise.all(fileUris.map(executeMentionFileCommand))).reduce(
      getSuccessCount,
      0
    )

    telemetry.trackEvent(TELEMETRY_EVENTS.FILES.ADD_SELECTION, {
      fileCount,
      folderCount,
      recursive
    })
  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to add selection to Cody: ${error.message}`)
  }
}

export async function addFolder(folderUri: vscode.Uri, recursive = true) {
  const telemetry = TelemetryService.getInstance()
  try {
    const { folderCount, fileUris } = await getSelectedFolderCount([folderUri], {
      recursive,
      progressTitle: 'Adding folder to Cody'
    })

    const fileCount = (await Promise.all(fileUris.map(executeMentionFileCommand))).reduce(
      getSuccessCount,
      0
    )

    telemetry.trackEvent(TELEMETRY_EVENTS.FILES.ADD_FOLDER, {
      fileCount,
      folderCount,
      recursive
    })
  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to add folder to Cody: ${error.message}`)
  }
}

export async function addFilesSmart(folderUris: vscode.Uri[], context: vscode.ExtensionContext) {
  const telemetry = TelemetryService.getInstance()
  let currentProvider = await getProviderConfig()

  if (!currentProvider) {
    vscode.window.showInformationMessage(
      'No LLM provider configured for Smart Add. Please set one up.'
    )
    const providerSelected = await selectProvider()
    if (!providerSelected) {
      vscode.window.showWarningMessage(
        'Provider setup cancelled or failed. Smart Add cannot proceed.'
      )
      return // Exit if provider setup failed or was cancelled
    }
    // Re-fetch the provider after selection
    currentProvider = await getProviderConfig()

    // Double-check if the provider is now set
    if (!currentProvider) {
      vscode.window.showErrorMessage(
        'Failed to configure the provider after selection. Please try again or check settings.'
      )
      return
    }
  }

  try {
    // Prompt user for file selection criteria
    const prompt = await vscode.window.showInputBox({
      prompt: 'Describe the files you want to add to Cody',
      placeHolder: 'e.g., all test files and services related to user authentication',
      ignoreFocusOut: true
    })

    if (!prompt) {
      return // User cancelled
    }

    // Determine the root URI (workspace or specific folder)
    const rootUri =
      folderUris.length === 1 &&
      (await vscode.workspace.fs.stat(folderUris[0])).type === vscode.FileType.Directory
        ? folderUris[0]
        : vscode.workspace.workspaceFolders?.[0].uri

    if (!rootUri) {
      vscode.window.showErrorMessage('No workspace or folder selected.')
      return
    }

    // Create LLM provider and ensure authenticated
    const llm = createProvider(currentProvider)

    // Show progress notification
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Analyzing files that match your criteria...',
        cancellable: true
      },
      async (progress, token) => {
        try {
          progress.report({ increment: 20, message: 'Scanning workspace files...' })
          const fileTree = await getWorkspaceFileTree(rootUri)

          progress.report({
            increment: 30,
            message: `Creating file selection query for ${fileTree.length} files...`
          })
          const messages = await createCompletionRequestMessages(prompt, rootUri)

          progress.report({ increment: 20, message: 'Getting AI recommendations...' })
          // Call LLM
          const response = await llm.complete({
            messages
          })

          progress.report({ increment: 15, message: 'Processing selected files...' })
          const selectedFiles: string[] = parseLLMResponse(response.text)

          // Convert paths to URIs and add to Cody
          const selectedFileUris = selectedFiles.map(filePath => vscode.Uri.file(filePath))

          // Count unique folders from the selected files
          const uniqueFolders = new Set<string>()
          selectedFiles.forEach(filePath => {
            const dirPath = path.dirname(filePath)
            uniqueFolders.add(dirPath)
          })
          const folderCount = uniqueFolders.size

          progress.report({ increment: 15, message: 'Adding files to Cody...' })
          const fileCount = (
            await Promise.all(selectedFileUris.map(executeMentionFileCommand))
          ).reduce(getSuccessCount, 0)

          telemetry.trackEvent(TELEMETRY_EVENTS.FILES.ADD_SMART_SELECTION, {
            fileCount,
            folderCount
          })

          // Provide feedback to the user.
          const relativePath = vscode.workspace.asRelativePath(rootUri)
          const successMessage = `Added ${fileCount} file${fileCount !== 1 ? 's' : ''} from '${relativePath}' that match your criteria:\n "${prompt}"`

          // Use simplified tree view with maxDisplayLength of 50
          const treeStructure = formatFileTree(rootUri.fsPath, fileTree, selectedFiles, 50)

          const totalFiles = fileTree.length
          vscode.window.showInformationMessage(
            `Cody++: ${fileCount}/${totalFiles} files successfully added`,
            {
              detail: `${successMessage}\n\n${treeStructure}`,
              modal: true
            }
          )
        } catch (error: any) {
          vscode.window.showErrorMessage(`Failed to add files smart to Cody: ${error.message}`)
          throw error
        }
      }
    )
  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to add files smart to Cody: ${error.message}`)
  }
}
