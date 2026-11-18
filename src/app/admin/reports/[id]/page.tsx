import { redirect, notFound } from "next/navigation";
import { AdminUnavailable } from "@/components/admin-live";
import { AdminReportDetailLive } from "@/components/admin-report-detail-live";
import { backendMode } from "@/lib/backend";
import { requireAdminSession } from "@/server/admin-gate";
import { getReport, getReportContent } from "@/server/admin-reports";
export const dynamic="force-dynamic";
export const metadata={title:"通報 | Campus Link 管理"};
export default async function Page({params}:{params:Promise<{id:string}>}) {
 if(backendMode()==="demo")notFound();
 const {id}=await params;
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))notFound();
 const path=`/admin/reports/${id}`; const client=await requireAdminSession(path); if(!client)return <AdminUnavailable/>;
 const r=await getReport(client,id);
 if(r.status==="forbidden")notFound(); if(r.status==="unauthenticated")redirect(`/login?next=${encodeURIComponent(path)}`);
 if(r.status!=="ok")return <AdminUnavailable/>; if(!r.report)notFound();
 // Before order 33 (or on any failure) the report still opens; only its content section says it cannot show.
 const content=await getReportContent(client,id);
 return <AdminReportDetailLive report={r.report} content={content.status==="ok"?content.content:null}/>;
}
