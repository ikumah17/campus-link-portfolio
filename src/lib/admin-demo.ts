"use client";

import { createContext, createElement, useContext, useState, type ReactNode } from "react";
import { demoAffiliations } from "@/data/demo-affiliations";
import { createDemoReports, demoModerator } from "@/data/demo-reports";
import { isParty, validTransition, validNote, validName, validAccountTransition, type AdminGateway, type Affiliation, type AdminResult, type AccountStatus } from "@/lib/admin-gateway";

export function createAdminDemo(moderator = demoModerator) {
  let reports = createDemoReports();
  let items: Affiliation[] = demoAffiliations.flatMap((school, s) => [
    { id: school.id, level: "school", parentId: null, name: school.name, isActive: true, sortOrder: s, academicYear: null } as Affiliation,
    ...school.departments.flatMap((dept, d) => [
      { id: dept.id, level: "department", parentId: school.id, name: dept.name, isActive: true, sortOrder: d, academicYear: null } as Affiliation,
      ...dept.classes.map((cls) => ({ id: cls.id, level: "class", parentId: dept.id, name: cls.name, isActive: true, sortOrder: 0, academicYear: 2026 } as Affiliation)),
    ]),
  ]);
  let sequence = 0;
  const accounts = new Map<string, AccountStatus>([["fictional-a", "active"], ["fictional-b", "suspended"]]);
  function upsert(level: Affiliation["level"], id: string | null, parentId: string | null, name: string, isActive: boolean, sortOrder: number, academicYear: number | null): AdminResult<Affiliation> {
    if (!validName(level, name) || typeof isActive !== "boolean" || !Number.isInteger(sortOrder) || sortOrder < -2147483648 || sortOrder > 2147483647 || (academicYear !== null && (!Number.isInteger(academicYear) || academicYear < -32768 || academicYear > 32767))) return { code: "validation", data: null };
    if (level !== "school" && !items.some((r) => r.id === parentId && r.level === (level === "department" ? "school" : "department"))) return { code: "validation", data: null };
    const prior = items.find((r) => r.id === id && r.level === level);
    if (id !== null && !prior) return { code: "not_available", data: null };
    if (prior && prior.parentId !== parentId) return { code: "invalid_state", data: null };
    if (items.some((r) => r.id !== id && r.level === level && r.parentId === parentId && r.name === name && (level !== "class" || r.academicYear === academicYear))) return { code: "invalid_state", data: null };
    const row = { id: id ?? `admin-affiliation-${++sequence}`, level, parentId, name, isActive, sortOrder, academicYear };
    items = prior ? items.map((r) => r.id === id ? row : r) : [...items, row];
    return { code: "ok", data: { ...row } };
  }
  const gateway: AdminGateway = {
    adminListReports(status) {
      // A disabled party placeholder demonstrates unavailability, without its evidence.
      return { code: "ok", data: reports.filter((r) => status === null || r.status === status).map(({ id, context, reason, createdAt, status, ...r }) => ({ id, context, reason, createdAt, status, available: !isParty({ id, context, reason, createdAt, status, ...r }, moderator) })) };
    },
    adminGetReport(id) { const row = reports.find((r) => r.id === id); return !row || isParty(row, moderator) ? { code: "not_available", data: null } : { code: "ok", data: { ...row } }; },
    adminUpdateReport(id, status, note) {
      if (!validNote(note)) return { code: "validation", data: null };
      const row = reports.find((r) => r.id === id);
      if (!row || isParty(row, moderator)) return { code: "not_available", data: null };
      if (!validTransition(row.status, status)) return { code: "invalid_state", data: null };
      const next = { ...row, status, note }; reports = reports.map((r) => r.id === id ? next : r);
      return { code: "ok", data: { ...next } };
    },
    adminUpsertSchool: (id, name, active, sort) => upsert("school", id, null, name, active, sort, null),
    adminUpsertDepartment: (id, parent, name, active, sort) => upsert("department", id, parent, name, active, sort, null),
    adminUpsertClass: (id, parent, name, year, active) => upsert("class", id, parent, name, active, 0, year),
    adminSetAccountStatus(user, status, reason) {
      if (!["active", "suspended"].includes(status) || (reason !== null && !/^[a-z0-9_]{1,64}$/.test(reason))) return { code: "validation", data: null };
      const prior = accounts.get(user);
      if (!prior) return { code: "not_available", data: null };
      if (!validAccountTransition(prior, status)) return { code: "invalid_state", data: null };
      accounts.set(user, status); return { code: "ok", data: status };
    },
  };
  return { gateway, affiliations: () => items.map((r) => ({ ...r })) };
}
const AdminContext = createContext<{ demo: ReturnType<typeof createAdminDemo>; refresh: () => void } | null>(null);
export function AdminProvider({ children }: { children: ReactNode }) {
  const [demo] = useState(createAdminDemo); const [, setRevision] = useState(0);
  return createElement(AdminContext.Provider, { value: { demo, refresh: () => setRevision((r) => r + 1) } }, children);
}
export function useAdmin() { const value = useContext(AdminContext); if (!value) throw new Error("AdminProvider required"); return value; }
