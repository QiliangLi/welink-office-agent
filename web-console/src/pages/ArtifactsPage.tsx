import { AlertTriangle, Archive } from "lucide-react";
import { Link } from "react-router-dom";
import { useQuery } from "../queries/core";
import { queryKeys } from "../queries/keys";
import { useAppData } from "../state/AppDataContext";

/**
 * First-stage artifacts page: the runtime has no artifact model yet, so the
 * page reports the capability state instead of fabricating a list
 * (docs/sidebar-pages-design.md §6). When the capability flips on but the
 * list API is still missing, the page says so instead of showing fakes.
 */
export function ArtifactsPage() {
  const { client } = useAppData();
  const healthQuery = useQuery(queryKeys.health(), () => client.getHealth());
  const health = healthQuery.data;

  return (
    <div className="page artifacts-page">
      <div className="page-heading">
        <div>
          <h1>产物</h1>
          <p>查看任务产出的文件和交付物。</p>
        </div>
      </div>

      {healthQuery.loading && !health ? (
        <section className="panel"><div className="skeleton-panel" style={{ height: 260 }} /></section>
      ) : healthQuery.error && !health ? (
        <section className="panel">
          <div className="table-empty">
            <AlertTriangle aria-hidden="true" />
            <h2>无法确认产物能力状态</h2>
            <p>{healthQuery.error.message}</p>
            <button className="button button-secondary" onClick={healthQuery.refetch}>重试</button>
          </div>
        </section>
      ) : health && !health.capabilities.artifacts ? (
        <section className="panel">
          <div className="capability-unavailable">
            <Archive aria-hidden="true" />
            <h2>产物功能尚未接入</h2>
            <p>任务的执行结果目前保留在任务详情和执行记录中。产物能力接入后，这里会展示可查看和下载的真实产物。</p>
            <div className="capability-actions">
              <Link className="button button-primary" to="/tasks?status=completed">查看已完成任务</Link>
              <Link className="button button-secondary" to="/tasks/new">创建任务</Link>
            </div>
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="table-empty">
            <h2>产物列表接口尚未接入</h2>
            <p>产物能力已开启，但产物列表和下载接口仍在建设中。接入后会在这里展示真实产物。</p>
          </div>
        </section>
      )}
    </div>
  );
}
