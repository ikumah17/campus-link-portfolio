import Link from "next/link";
import { AdminLiveShell } from "@/components/admin-live";
import { contextLabels,reportStatuses,statusLabels,type ReportStatus } from "@/lib/admin-gateway";
import { reportReasons } from "@/lib/safety-gateway";
import type { ReportRow } from "@/server/admin-reports";
import { pageTitle } from "@/components/ui-tokens";
export function reportDate(value:string) {const d=new Date(value);return Number.isFinite(d.getTime())?new Intl.DateTimeFormat("ja-JP",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit"}).format(d):"日時不明";}
export function AdminReportListLive({reports,status}:{reports:ReportRow[];status:ReportStatus}) {
 return <AdminLiveShell><h1 className={`mt-5 ${pageTitle}`}>通報</h1><p className="mt-4">閲覧と変更は監査記録に保存されます。</p>
 <nav aria-label="通報の状態" className="my-6 flex gap-5">{reportStatuses.map(s=><Link key={s} href={`?status=${s}`} aria-current={s===status?"page":undefined}>{statusLabels[s]}</Link>)}</nav>
 {reports.length===0?<p>この状態の通報はありません。</p>:<ul>{reports.map(r=><li key={r.id} className="border-b border-line py-5"><Link prefetch={false} href={`/admin/reports/${r.id}`} className="block space-x-3"><span>{contextLabels[r.context]}</span><span>{reportReasons[r.reason]}</span><span>{r.targetLabel??"対象なし"}</span><time dateTime={r.createdAt}>{reportDate(r.createdAt)}</time><span>{statusLabels[r.status]}</span></Link></li>)}</ul>}</AdminLiveShell>;
}
