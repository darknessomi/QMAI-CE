/** Opaque Responses items stay in the agent's current conversation for tool-result replay. */
export interface ResponseOutputItem {
  type: string
  [key: string]: unknown
}

interface PendingCall {
  type: "function_call"
  call_id: string
  name: string
  arguments: string
  [key: string]: unknown
}

/** Execute tool calls only when the response finished, with the service's final arguments. */
export class ResponsesStream {
  private readonly items = new Map<number, ResponseOutputItem>()
  private readonly calls = new Map<number, PendingCall>()
  output: ResponseOutputItem[] | undefined
  finished = false

  accept(line: string): void {
    if (!line.startsWith("data:")) return
    let event
    try { event = JSON.parse(line.slice(5)) } catch { return }
    if (!event || typeof event !== "object") return
    const index = event.output_index
    switch (event.type) {
      case "response.output_item.added":
        if (event.item?.type === "function_call") {
          this.calls.set(index, { ...event.item, arguments: event.item.arguments ?? "" })
        }
        break
      case "response.function_call_arguments.delta": {
        const call = this.calls.get(index)
        if (call && typeof event.delta === "string") call.arguments += event.delta
        break
      }
      case "response.function_call_arguments.done": {
        const call = this.calls.get(index)
        if (call && typeof event.arguments === "string") call.arguments = event.arguments
        break
      }
      case "response.output_item.done":
        if (event.item?.type) this.items.set(index, event.item)
        break
      case "response.completed":
        this.finished = true
        for (const [i, call] of this.calls) {
          if (!this.items.has(i)) this.items.set(i, call)
        }
        this.output = Array.isArray(event.response?.output) && event.response.output.length
          ? event.response.output
          : Array.from(this.items).sort(([a], [b]) => a - b).map(([, item]) => item)
        break
      case "response.incomplete":
        this.finished = true
        break
    }
  }
}
