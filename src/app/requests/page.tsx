import { permanentRedirect } from "next/navigation";
// The request page became the likes page (order 34, docs/43 §4.1); old bookmarks land there.
export default function RequestsPage() { permanentRedirect("/likes"); }
