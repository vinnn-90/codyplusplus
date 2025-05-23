import * as vscode from 'vscode'
import { createProvider } from '../core/llm'
import {
  CONFIG_KEYS,
  LLMProviderDetails,
  SUPPORTED_PROVIDERS,
  SUPPORTED_PROVIDER_CODES
} from '../core/llm/constants'
import {
  updateApiKeyConfig,
  updateBaseUrlConfig,
  updateModelConfig,
  updateProviderConfig
} from '../utils/workspace-config'

export const selectProvider = async (): Promise<boolean> => {
  // --- Step 1: Select Provider ---
  const providerChoices = SUPPORTED_PROVIDERS.map(p => ({
    label: p.name,
    description: p.code,
    provider: p
  }))

  const selectedChoice = await vscode.window.showQuickPick(providerChoices, {
    placeHolder: 'Select the LLM provider for Smart Add'
  })

  if (!selectedChoice) {
    vscode.window.showInformationMessage('Provider selection cancelled.')
    return false // Cancelled
  }
  const selectedProvider: LLMProviderDetails = selectedChoice.provider

  // --- Step 2: Get API Key ---
  const apiKey = await vscode.window.showInputBox({
    prompt: `Enter your ${selectedProvider.name} API key`,
    password: true,
    placeHolder: 'Paste your API key here...',
    ignoreFocusOut: true
  })

  if (apiKey === undefined) {
    // Undefined means user cancelled the input box (Escape key)
    vscode.window.showInformationMessage('API key entry cancelled.')
    return false // Cancelled
  }
  if (!apiKey) {
    // Empty string means user submitted without entering a key
    vscode.window.showWarningMessage('API key cannot be empty. Provider setup cancelled.')
    return false // Treat empty string as cancellation for atomicity
  }

  // --- Step 3: Get Base URL (if applicable) ---
  let finalBaseUrl = selectedProvider.baseURL
  if (selectedProvider.code === 'openai-compatible') {
    const currentBaseUrl = vscode.workspace
      .getConfiguration('codyPlusPlus')
      .get<string>(CONFIG_KEYS.OPENAI_BASE_URL)

    const baseUrlInput = await vscode.window.showInputBox({
      prompt: 'Enter base URL (leave empty for default)',
      placeHolder: selectedProvider.baseURL,
      value: currentBaseUrl || '', // Use empty string if undefined for the input box
      ignoreFocusOut: true
    })

    if (baseUrlInput === undefined) {
      vscode.window.showInformationMessage('Base URL entry cancelled.')
      return false // Cancelled
    }
    // Update finalBaseUrl only if user entered something or explicitly cleared it to empty
    finalBaseUrl = baseUrlInput || selectedProvider.baseURL
  }

  // --- Step 4: Get Model ---
  const currentModel = vscode.workspace
    .getConfiguration('codyPlusPlus')
    .get<string>(CONFIG_KEYS.MODEL)

  let models: string[] = []
  try {
    // Use the potentially custom finalBaseUrl and collected apiKey for fetching
    const tempProvider = createProvider(selectedProvider.code, {
      apiKey: apiKey, // Pass the entered key
      baseUrl: finalBaseUrl // Pass the potentially custom URL
    })
    models = await tempProvider.fetchModels()
  } catch (error: any) {
    console.error(`Failed to fetch models for ${selectedProvider.name}:`, error)
    vscode.window.showWarningMessage(
      `Could not fetch models from ${finalBaseUrl}. Error: ${error.message}. Please enter the model name manually.`
    )
    // Allow manual entry even if fetch fails
  }

  let modelInput: string | undefined
  if (models.length > 0) {
    modelInput = await vscode.window.showQuickPick(models, {
      placeHolder: `Select a model (current: ${currentModel || 'Default'})`,
      title: `Choose ${selectedProvider.name} Model`,
      canPickMany: false,
      ignoreFocusOut: true
      // No default value here, let user explicitly select or cancel
    })
  } else {
    modelInput = await vscode.window.showInputBox({
      prompt: `Enter model name (leave empty for default: ${selectedProvider.defaultModel})`,
      placeHolder: selectedProvider.defaultModel,
      value: currentModel || '', // Use empty string if undefined
      ignoreFocusOut: true
    })
  }

  if (modelInput === undefined) {
    vscode.window.showInformationMessage('Model selection cancelled.')
    return false // Cancelled
  }

  // Use provider default if model input is empty string, otherwise use the input
  const finalModel = modelInput || selectedProvider.defaultModel

  // --- All steps completed successfully, now update configuration ---
  try {
    await updateProviderConfig(selectedProvider.code)
    await updateApiKeyConfig(apiKey)

    if (selectedProvider.code === 'openai-compatible') {
      await updateBaseUrlConfig(selectedProvider.code, finalBaseUrl)
    } else {
      await updateBaseUrlConfig(selectedProvider.code, undefined) // Clear specific OpenAI URL if not compatible
    }

    await updateModelConfig(finalModel)

    console.log(
      `Successfully configured ${selectedProvider.name} as LLM provider with model ${finalModel}`
    )
    vscode.window.showInformationMessage(
      `Successfully configured ${selectedProvider.name} as LLM provider with model ${finalModel}`
    )

    return true // Indicate success
  } catch (error: any) {
    console.error('Failed to update provider configuration:', error)
    vscode.window.showErrorMessage(
      `Failed to save provider configuration: ${error.message || 'Unknown error'}`
    )
    return false // Indicate failure during update
  }
}

export const selectLLM = async (): Promise<boolean> => {
  // Get current configuration
  const config = vscode.workspace.getConfiguration('codyPlusPlus')
  const currentProviderCode = config.get<string>(CONFIG_KEYS.PROVIDER) || 'openai'
  const currentApiKey = config.get<string>(CONFIG_KEYS.API_KEY)
  const currentBaseUrl = config.get<string>(CONFIG_KEYS.OPENAI_BASE_URL)
  const currentModel = config.get<string>(CONFIG_KEYS.MODEL)

  // Ensure provider and API key are set
  if (!currentProviderCode || !currentApiKey) {
    vscode.window.showWarningMessage(
      'Provider and API key must be configured first. Use the "Select LLM Provider" command.'
    )
    return false
  }

  const providerDetails = SUPPORTED_PROVIDERS.find(p => p.code === currentProviderCode)
  if (!providerDetails) {
    vscode.window.showErrorMessage(
      `Configuration Error: Invalid provider code '${currentProviderCode}'.`
    )
    return false
  }

  let models: string[] = []
  try {
    // Use current config to create provider for fetching models
    const provider = createProvider(currentProviderCode as SUPPORTED_PROVIDER_CODES, {
      apiKey: currentApiKey,
      baseUrl:
        currentProviderCode === 'openai-compatible' ? currentBaseUrl : providerDetails.baseURL
    })
    models = await provider.fetchModels()
  } catch (error: any) {
    console.error(`Failed to fetch models for ${providerDetails.name}:`, error)
    vscode.window.showWarningMessage(
      `Could not fetch models. Error: ${error.message}. Please enter the model name manually.`
    )
    // Allow manual entry even if fetch fails
  }

  let modelInput: string | undefined
  if (models.length > 0) {
    modelInput = await vscode.window.showQuickPick(models, {
      placeHolder: `Select a model (current: ${currentModel || providerDetails.defaultModel})`,
      title: `Choose ${providerDetails.name} Model`,
      canPickMany: false,
      ignoreFocusOut: true
    })
  } else {
    modelInput = await vscode.window.showInputBox({
      prompt: `Enter model name (leave empty for default: ${providerDetails.defaultModel})`,
      placeHolder: providerDetails.defaultModel,
      value: currentModel || '', // Use empty string if undefined
      ignoreFocusOut: true
    })
  }

  if (modelInput === undefined) {
    vscode.window.showInformationMessage('Model selection cancelled.')
    return false // Cancelled
  }

  // Use provider default if model input is empty string, otherwise use the input
  const finalModel = modelInput || providerDetails.defaultModel

  if (finalModel === currentModel) {
    vscode.window.showInformationMessage(
      'Selected model is the same as the current one. No changes made.'
    )
    return true // No change needed, considered success
  }

  // Update only the model configuration
  try {
    await updateModelConfig(finalModel)
    console.log(
      `Successfully updated LLM model to ${finalModel} for provider ${providerDetails.name}`
    )
    vscode.window.showInformationMessage(`Successfully updated LLM model to ${finalModel}`)
    return true // Indicate success
  } catch (error: any) {
    console.error('Failed to update model configuration:', error)
    vscode.window.showErrorMessage(
      `Failed to save model configuration: ${error.message || 'Unknown error'}`
    )
    return false // Indicate failure during update
  }
}
