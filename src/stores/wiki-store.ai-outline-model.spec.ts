import { beforeEach, describe, expect, it } from "vitest"

import { useWikiStore } from "@/stores/wiki-store"

describe("wiki-store AI outline model", () => {
  beforeEach(() => {
    useWikiStore.setState({
      aiChatModel: "openai/chat-model",
      aiOutlineModel: "",
      defaultLlmModel: "openai/default-model",
    })
  })

  it("updates only the global outline model without changing chat or defaults", () => {
    useWikiStore.getState().setAiOutlineModel("openai/gpt-6.2-sol")

    const state = useWikiStore.getState()
    expect(state.aiOutlineModel).toBe("openai/gpt-6.2-sol")
    expect(state.aiChatModel).toBe("openai/chat-model")
    expect(state.defaultLlmModel).toBe("openai/default-model")
  })
})
