import { redirect } from "next/navigation";

// Position Trends retired — its portfolio-visibility chart now lives at the
// top of the Search & Profit board (/visibility).
export default function Page() {
  redirect("/visibility");
}
