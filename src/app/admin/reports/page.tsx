import { redirect, notFound } from "next/navigation";
import { AdminReports } from "@/components/admin-reports";
import { AdminUnavailable } from "@/components/admin-live";
import { AdminReportListLive } from "@/components/admin-report-list-live";
import { backendMode } from "@/lib/backend";
import { reportStatuses, type ReportStatus } from "@/lib/admin-gateway";
import { requireAdminSession } from "@/server/admin-gate";
import { listReports } from "@/server/admin-reports";
export const dynamic="force-dynamic";
export default async function Page({searchParams}:{searchParams?:Promise<{status?:string|string[]}>}={}) {
 if(backendMode()==="demo") return <AdminReports/>;
 const client=await requireAdminSession("/admin/reports"); if(!client)return <AdminUnavailable/>;
 const q=await searchParams; const status=reportStatuses.includes(q?.status as ReportStatus)?q!.status as ReportStatus:"open";
 const r=await listReports(client,status);
 if(r.status==="forbidden")notFound(); if(r.status==="unauthenticated")redirect("/login?next=%2Fadmin%2Freports");
 if(r.status!=="ok")return <AdminUnavailable/>;
 return <AdminReportListLive reports={r.reports} status={status}/>;
}
