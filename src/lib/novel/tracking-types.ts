/**
 * 追踪层统一类型定义
 * 供写作进度、人物状态和伏笔记录使用
 */

/** 角色状态变更记录 */
export interface StateChangeRecord {
  chapter: number
  change: string
  timestamp: string
}

/** 伏笔重要度 */
export type ForeshadowingImportance = "high" | "medium" | "low"

/** 伏笔状态 */
export type ForeshadowingStatus = "planted" | "advanced" | "resolved" | "abandoned"

/** 已回收伏笔记录 */
export interface ResolvedForeshadowingRecord {
  id: string
  resolvedInChapter: number
  resolution: string
}

/** 写作进度（上下文.md） */
export interface WritingProgress {
  lastCompletedChapter: number
  lastCompletedChapterTitle: string
  lastUpdated: string
  currentArc: string
  activeForeshadowingCount: number
  keyPendingForeshadowing: string[]
  relationshipStatus: string
  nextChapterGuidance: string
  notes: string[]
}