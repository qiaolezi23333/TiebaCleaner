import type { ReactNode } from 'react'
import { Empty } from 'antd'

export default function EmptyState({
  description,
  action
}: {
  description: string
  action?: ReactNode
}): React.JSX.Element {
  return (
    <div className="empty-state">
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={description} />
      {action}
    </div>
  )
}
