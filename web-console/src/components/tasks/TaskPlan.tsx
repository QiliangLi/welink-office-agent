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

/**
 * Phase one renders each required runtime subtask as one flat step; the
 * runtime introduces parent/child relations only when they actually exist.
 */
export function TaskPlan({ steps }: { steps: PlanStep[] }) {
  if (!steps.length) return <p className="empty-inline">Agent 尚未生成执行计划。</p>;
  return (
    <ul className="task-plan">
      {steps.map((step) => {
        const Icon = stepIcons[step.status];
        return (
          <li className={`plan-node plan-${step.status}`} key={step.id}>
            <div className="plan-row">
              <span className="plan-marker"><Icon aria-hidden="true" /></span>
              <div className="plan-content">
                <div className="plan-title-row">
                  <strong>{step.title}</strong>
                  {step.owner && <span className="plan-owner">{step.owner.name} · {step.owner.department || "参与人"}</span>}
                </div>
                {step.summary && <p>{step.summary}</p>}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
