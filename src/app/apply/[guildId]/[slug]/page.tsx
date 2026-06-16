import { PublicForm } from "@/components/recruitment/public-form";

/**
 * Public recruitment application page — top-level (outside the dashboard app
 * shell) so it renders as a clean, guild-branded standalone form. Anonymous;
 * the form + submission go through the public `recruitment` procedures. Served
 * by the hardened `recruit-public` container in production (APP_ROLE gate).
 */
export default async function ApplyPage({
  params,
}: {
  params: Promise<{ guildId: string; slug: string }>;
}) {
  const { guildId, slug } = await params;
  return <PublicForm guildId={guildId} slug={slug} />;
}
