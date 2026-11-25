import { beforeEach, describe, expect, it, vi } from "vitest"

const saveAiChatModel = vi.fn<(model: string) => Promise<void>>(async () => {})

vi.mock("@/lib/project-store", () => ({
  saveAiChatModel: (model: string) => saveAiChatModel(model),
}))

import { ensureAiChatModelSelected } from "./ensure-ai-chat-model"
import { useWikiStore } from "@/stores/wiki-store"
import type { ProviderConfigs } from "@/stores/wiki-store"

function saved(id: string) {
  return { id, model: id, name: id, createdAt: 1 }
}

const availableConfigs: ProviderConfigs = {
  openai: { enabled: true, apiKey: "key", savedModels: [saved("gpt-4o"), saved("gpt-4.1")] },
  "codex-cli": { enabled: true, savedModels: [saved("gpt-6.2-sol")] },
}

describe("ensureAiChatModelSelected", () => {
  beforeEach(() => {
    saveAiChatModel.mockClear()
    useWikiStore.setState({
      aiChatModel: "",
      providerConfigs: {},
    })
  })

  it("does nothing when no provider models are available", () => {
    expect(ensureAiChatModelSelected()).toBe("")
    expect(useWikiStore.getState().aiChatModel).toBe("")
    expect(saveAiChatModel).not.toHaveBeenCalled()
  })

  it("keeps an already selected chat model", () => {
    useWikiStore.setState({
      aiChatModel: "codex-cli/gpt-6.2-sol",
      providerConfigs: availableConfigs,
    })

    expect(ensureAiChatModelSelected()).toBe("codex-cli/gpt-6.2-sol")
    expect(useWikiStore.getState().aiChatModel).toBe("codex-cli/gpt-6.2-sol")
    expect(saveAiChatModel).not.toHaveBeenCalled()
  })

  it("selects the first available model when chat model is empty", () => {
    useWikiStore.setState({ providerConfigs: availableConfigs })

    expect(ensureAiChatModelSelected()).toBe("openai/gpt-4o")
    expect(useWikiStore.getState().aiChatModel).toBe("openai/gpt-4o")
    expect(saveAiChatModel).toHaveBeenCalledWith("openai/gpt-4o")
  })
})
