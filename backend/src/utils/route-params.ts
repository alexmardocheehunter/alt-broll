/** Identifiant de projet de l'URL ; '' s'il est absent ou multiple (le projet sera alors introuvable). */
export function idParam(params: Readonly<Record<string, unknown>>): string {
  const { id } = params;
  return typeof id === 'string' ? id : '';
}
