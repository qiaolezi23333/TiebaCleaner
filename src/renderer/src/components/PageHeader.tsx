import type { ReactNode } from 'react'

interface PageHeaderProps {
  eyebrow?: string
  title: string
  extra?: ReactNode
}

export default function PageHeader({ eyebrow, title, extra }: PageHeaderProps): React.JSX.Element {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <span className="page-eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
      </div>
      {extra && <div className="page-header-actions">{extra}</div>}
    </header>
  )
}
