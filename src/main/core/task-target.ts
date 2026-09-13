import type { CleanupItem, CleanupKind } from '../../shared/types'

const TARGET_PREVIEW_LENGTH = 32

const actionLabels: Record<CleanupKind, { present: string; completed: string }> = {
  reply: { present: '删除评论', completed: '已删除评论' },
  post: { present: '删除主题帖', completed: '已删除主题帖' },
  followingUser: { present: '取消关注用户', completed: '已取消关注用户' },
  followingForum: { present: '取消关注贴吧', completed: '已取消关注贴吧' },
  follower: { present: '移除粉丝', completed: '已移除粉丝' }
}

export function cleanupTargetPreview(item: CleanupItem): string {
  const raw =
    item.kind === 'followingForum'
      ? item.forumName || item.title
      : item.kind === 'followingUser' || item.kind === 'follower'
        ? item.displayName || item.title
        : item.title || item.summary
  const compact = raw.replace(/\s+/gu, ' ').trim() || '未命名项目'
  const characters = Array.from(compact)
  return characters.length > TARGET_PREVIEW_LENGTH
    ? `${characters.slice(0, TARGET_PREVIEW_LENGTH - 1).join('')}…`
    : compact
}

export function completedItemMessage(item: CleanupItem): string {
  return `${actionLabels[item.kind].completed}“${cleanupTargetPreview(item)}”`
}

export function failedItemMessage(item: CleanupItem, reason: string): string {
  return `${actionLabels[item.kind].present}“${cleanupTargetPreview(item)}”失败：${reason}`
}
