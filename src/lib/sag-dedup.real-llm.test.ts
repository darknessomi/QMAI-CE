// @vitest-environment node
import { nativeBridge } from "@/test-helpers/sag-native-bridge"
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, vi } from "vitest"
import { runDuplicateDetection } from "./dedup-runner"
import { extractEntitySummary, normalizeGroupKey } from "./dedup"
import { DETECTOR_BATCH_SIZE, windowBatches } from "./dedup-candidates"
import { invoke } from "@tauri-apps/api/core"

// The adapter replaces only desktop IPC and FS transport. Runtime page loading,
// candidate assembly, saved decisions, Jev requests, and thresholds stay real.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))
vi.mock("@/commands/fs", () => ({
  readFile: (path: string) => readFile(path, "utf8"),
  fileExists: async (path: string) => { try { await access(path); return true } catch { return false } },
}))
vi.mock("./jev-config", async (importOriginal) => ({
  ...await importOriginal<typeof import("./jev-config")>(),
  getJevConfig: () => ({ endpoint: "http://localhost", model: "native-bridge" }),
}))

const enabled = process.env.QMAI_SAG_DEDUP_EVAL === "1"
const key = (a: string, b: string) => normalizeGroupKey([a, b])
const records: { slug: string; title: string; text: string; aliases?: string[] }[] = [
  { slug: "a-arbor", title: "Aster", text: "旧驿名册上的北岚曾用名阿瑟。她佩戴裂纹铜徽，用第七十二号木牌调阅盐船卷宗。" },
  { slug: "z-bailiff", title: "Zeno", text: "档案员北岚用第七十二号木牌调阅盐船卷宗，衣襟上那枚裂纹铜徽来自旧驿。她在新档案上署名泽诺。" },
  { slug: "archivist", title: "罗菁", aliases: ["灰鹭"], text: "罗菁是冬湾档案馆的保管员，代号灰鹭，亲手在名册上补录了冬港失踪案。" },
  { slug: "heron", title: "灰鹭", text: "冬湾档案馆保管员灰鹭就是罗菁；她在第二年把冬港失踪案名册移交给港务署。" },
  { slug: "harbor", title: "田澄", text: "南港船匠田澄，父亲田安，出生于一九七六年。他与北城同名的法官素无来往。" },
  { slug: "judge", title: "田澄", text: "北城法官田澄，母亲宋柳，出生于一九四二年。任命书注明他与另一名南港船匠同名。" },
  { slug: "staff-east", title: "观测站", text: "东区的观测站由西桥小学负责气象观测。" },
  { slug: "staff-west", title: "观测站", text: "西区的观测站隶属于红帆港务局，记录潮位数据。" },
]
const positives = [key("a-arbor", "z-bailiff"), key("archivist", "heron")]
const homonyms = key("harbor", "judge")
const dismissed = key("staff-east", "staff-west")

test.skipIf(!enabled)("使用已配置的 Jev 分别衡量候选召回与身份误判", async () => {
  // Synthetic single-token distractors put the gold pair outside an 80-page window.
  // Their queries share no evidence, avoiding dozens of paid calls for filler.
  const filler = Array.from({ length: DETECTOR_BATCH_SIZE }, (_, i) => {
    const token = "M" + String.fromCharCode(97 + Math.floor(i / 26), 97 + i % 26) + "yxv"
    return { slug: "m-" + token, title: token, text: token, aliases: [] }
  })
  const entries = [...records, ...filler]
  const root = await mkdtemp(join(tmpdir(), "qmai-sag-dedup-"))
  await mkdir(join(root, "QM/entities"), { recursive: true })
  await mkdir(join(root, ".qmai"))
  await writeFile(join(root, ".qmai/dedup-not-duplicates.json"), JSON.stringify([["staff-east", "staff-west"]]))
  const pages = await Promise.all(entries.map(async e => {
    const path = "QM/entities/" + e.slug + ".md"
    const content = ["---", "type: entity", "title: " + JSON.stringify(e.title), "aliases: " + JSON.stringify(e.aliases ?? []), "---", e.text].join("\n")
    await writeFile(join(root, path), content)
    return extractEntitySummary(path, content)!
  }))
  expect(windowBatches(pages).every(batch => !["a-arbor", "z-bailiff"].every(slug => batch.some(page => page.slug === slug)))).toBe(true)
  const bridge = nativeBridge()
  const judgments = new Map<string, number>()
  const calls = { search: 0, identity: 0 }
  const start = Date.now()
  try {
    vi.mocked(invoke).mockImplementation(async (command, raw) => {
      if (!["sag_search", "sag_judge_pair"].includes(command)) throw new Error("不支持的评测命令 " + command)
      const { config: _unused, ...args } = raw as Record<string, unknown>
      const response = await bridge.call({ command, ...args })
      if (response.error) throw new Error(response.error)
      if (command === "sag_search") calls.search += response.calls
      else {
        calls.identity += response.calls
        const slug = (text: unknown) => {
          const [title, ...lines] = String(text).split("\n")
          const record = entries.find(e => e.title === title && e.text.includes(lines.join("\n")))
          if (!record) throw new Error("判定引用无法回溯到实测原文")
          return record.slug
        }
        judgments.set(key(slug(args.left), slug(args.right)), Number(response.value))
      }
      return response.value as never
    })
    const output = await runDuplicateDetection(root, {} as Parameters<typeof runDuplicateDetection>[1], { summaries: pages })
    const accepted = new Set(output.groups.map(group => normalizeGroupKey(group.slugs)))
    const recalled = positives.filter(id => judgments.has(id)).length
    const found = positives.filter(id => accepted.has(id)).length
    const negatives = [...judgments.keys()].filter(id => !positives.includes(id))
    const falsePositives = negatives.filter(id => accepted.has(id))
    const report = {
      pages: pages.length, candidateRecall: { found: recalled, total: positives.length },
      identityFalsePositives: { count: falsePositives.length, judgedNegatives: negatives.length },
      acceptedGoldPairs: found, crossWindow: { recalled: judgments.has(positives[0]), accepted: accepted.has(positives[0]) },
      alias: { recalled: judgments.has(positives[1]), accepted: accepted.has(positives[1]) },
      homonym: { judged: judgments.has(homonyms), accepted: accepted.has(homonyms) },
      dismissedWasJudged: judgments.has(dismissed), manualReview: output.manualReview?.length ?? 0,
      elapsedMs: Date.now() - start, jevHttpCalls: calls,
    }
    console.log("QMAI_SAG_DEDUP=" + JSON.stringify(report))
    expect.soft(recalled).toBe(positives.length)
    expect.soft(found).toBe(positives.length)
    expect.soft(falsePositives).toHaveLength(0)
    expect.soft(judgments.has(homonyms)).toBe(true)
    expect.soft(judgments.has(dismissed)).toBe(false)
  } finally {
    bridge.close()
  }
}, 1_800_000)
