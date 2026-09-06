// Pulls the Jira-style task token (EM-2634) out of a branch name or MR
// title — the same convention this team's branches already follow
// (Feature-EM-2634-refactor-pagination).
function extractTask(text) {
  const m = String(text || '').match(/\bEM-(\d+)\b/i);
  return m ? `EM-${m[1]}` : null;
}

module.exports = { extractTask };
