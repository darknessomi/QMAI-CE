import { beforeEach, describe, expect, it, vi } from "vitest"
import { fetchLlmModelList } from "@/lib/settings-model-list"

const mockFetch = vi.fn()

vi.mock("@/lib/tauri-fetch", () => ({
  getHttpFetch: vi.fn(async () => mockFetch),
}))

describe("settings-model-list", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("awaits the fetch factory before requesting llm models", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "gpt-4.1-mini" }, { id: "gpt-4.1" }],
      }),
    })

    const config: Parameters<typeof fetchLlmModelList>[0] = {
      provider: "openai",
      apiKey: "sk-test",
      model: "gpt-4.1",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 32000,
    }

    await expect(fetchLlmModelList(config)).resolves.toEqual({
      models: ["gpt-4.1", "gpt-4.1-mini"],
    })
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test",
        }),
      }),
    )
  })
})
