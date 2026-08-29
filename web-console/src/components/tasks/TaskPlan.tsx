import { AlertTriangle, Check, Circle, Clock3, LoaderCircle, Minus } from "lucide-react";
import type { PlanStep, PlanStepStatus } from "../../types/domain";

const stepIcons = {
  pending: Circle,
  running: LoaderCircle,
  waiting: Clock3,
  completed: Check,
  failed: AlertTriangle,
  skipped: Minus,
} satisfies Record<PlanStepStatus, typeof Circle>;

function PlanNode({ step, level = 0 }: { step: PlanStep; level?: number }) {
  const Icon = stepIcons[step.status];
  return (
    <li className={`plan-node plan-${step.status}`}>
      <div className="plan-row" style={{ paddingLeft: `${level * 24}px` }}>
        <span className="plan-marker"><Icon aria-hidden="true" /></span>
        <div className="plan-content">
          <div className="plan-title-row">
            <strong>{step.title}</strong>
            {step.duration && <span>{step.duration}</span>}
          </div>
          {step.summary && <p>{step.summary}</p>}
          {step.owner && <span className="plan-owner">{step.owner.name} · {step.owner.department}</span>}
        </div>
      </div>
      {step.children?.length ? (
        <ul className="plan-children">
          {step.children.map((child) => <PlanNode key={child.id} step={child} level={level + 1} />)}
        </ul>
      ) : null}
    </li>
  );
}

export function TaskPlan({ steps }: { steps: PlanStep[] }) {
  if (!steps.length) return <p className="empty-inline">Agent 尚未生成执行计划。</p>;
  return <ul className="task-plan">{steps.map((step) => <PlanNode key={step.id} step={step} />)}</ul>;
}
