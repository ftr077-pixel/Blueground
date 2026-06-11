import { redirect } from "next/navigation";

// Pricing vs Rank retired (operator: not useful). Pricing analysis lives in
// Pricing Intelligence; search performance in Search & Profit.
export default function Page() {
  redirect("/visibility");
}
