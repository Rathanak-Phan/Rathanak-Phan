const API_VERSION = "2022-11-28";
const USERNAME = "Rathanak-Phan";
const OUTPUT_PATH = "profile/stats.svg";
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

const restHeaders = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": API_VERSION,
  "User-Agent": "Rathanak-Phan-profile-stats",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

function escapeXml(value = "") {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function truncate(value, length) {
  return value && value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function utcTimestamp() {
  return new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC", hour12: false }).format(new Date()).replace(",", "") + " UTC";
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function request(url, options = {}, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, { ...options, headers: { ...restHeaders, ...options.headers } });
    if (response.ok) return response.json();
    const retryable = response.status === 429 || response.status >= 500 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
    if (!retryable || attempt === attempts) throw new Error(`${response.status} ${response.statusText}`);
    const retryAfter = Number(response.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : attempt * 1000);
  }
}

async function fetchAllRepositories() {
  const repositories = [];
  for (let page = 1; ; page += 1) {
    const batch = await request(`https://api.github.com/users/${USERNAME}/repos?type=owner&sort=updated&direction=desc&per_page=100&page=${page}`);
    repositories.push(...batch);
    if (batch.length < 100) return repositories;
  }
}

async function fetchLanguages(repositories) {
  const totals = new Map();
  const owned = repositories.filter((repository) => !repository.fork);
  for (let index = 0; index < owned.length; index += 4) {
    const results = await Promise.all(owned.slice(index, index + 4).map(async (repository) => {
      try {
        return await request(repository.languages_url, {}, token ? 3 : 1);
      } catch (error) {
        console.warn(`Skipped language data for ${repository.name}: ${error.message}`);
        return null;
      }
    }));
    for (const languages of results.filter(Boolean)) {
      for (const [language, bytes] of Object.entries(languages)) totals.set(language, (totals.get(language) || 0) + bytes);
    }
  }
  return totals;
}

async function fetchContributions() {
  if (!token) return null;
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate())).toISOString();
  const query = `query($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
        totalCommitContributions
        totalPullRequestContributions
        totalIssueContributions
        totalPullRequestReviewContributions
      }
    }
  }`;
  try {
    const payload = await request("https://api.github.com/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { login: USERNAME, from, to: now.toISOString() } }),
    });
    if (payload.errors || !payload.data?.user) throw new Error(payload.errors?.map((error) => error.message).join("; ") || "GraphQL response missing user data");
    const collection = payload.data.user.contributionsCollection;
    return { ...collection, days: collection.contributionCalendar.weeks.flatMap((week) => week.contributionDays) };
  } catch (error) {
    console.warn(`Skipped contribution data: ${error.message}`);
    return null;
  }
}

function languageRows(languageTotals) {
  const entries = [...languageTotals.entries()].sort((first, second) => second[1] - first[1]);
  const total = entries.reduce((sum, [, bytes]) => sum + bytes, 0);
  const primary = entries.filter(([, bytes]) => total && bytes / total >= 0.01).slice(0, 7);
  const primaryNames = new Set(primary.map(([name]) => name));
  const remainder = entries.filter(([name]) => !primaryNames.has(name)).reduce((sum, [, bytes]) => sum + bytes, 0);
  if (remainder) primary.push(["Other", remainder]);
  const colors = ["#7aa2f7", "#bb9af7", "#9ece6a", "#e0af68", "#f7768e", "#7dcfff", "#73daca", "#c0caf5"];
  return primary.map(([name, bytes], index) => ({ name, percentage: (bytes / total) * 100, color: colors[index] }));
}

function heatmap(days, x, y) {
  const values = new Map(days.map((day) => [day.date, day.contributionCount]));
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 363);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  const colorFor = (count) => {
    if (count === 0) return "#24283b";
    if (count <= 2) return "#1f6f4a";
    if (count <= 5) return "#2ea043";
    if (count <= 9) return "#56d364";
    return "#9be9a8";
  };
  const cells = [];
  for (let week = 0; week < 53; week += 1) {
    for (let day = 0; day < 7; day += 1) {
      const date = new Date(start);
      date.setUTCDate(start.getUTCDate() + week * 7 + day);
      const count = values.get(date.toISOString().slice(0, 10)) || 0;
      cells.push(`<rect x="${x + week * 10}" y="${y + day * 10}" width="7" height="7" rx="1.5" fill="${colorFor(count)}"><title>${date.toISOString().slice(0, 10)}: ${count} contributions</title></rect>`);
    }
  }
  return cells.join("");
}

function activityLabel(event) {
  const labels = { PushEvent: "Pushed commits", PullRequestEvent: "Opened pull request", IssuesEvent: "Opened issue", PullRequestReviewEvent: "Reviewed pull request", CreateEvent: "Created", ForkEvent: "Forked repository", WatchEvent: "Starred repository" };
  return labels[event.type] || null;
}

function repositoryScore(repository) {
  const daysSinceUpdate = Math.max(0, (Date.now() - new Date(repository.updated_at).getTime()) / 86_400_000);
  return repository.stargazers_count * 5 + repository.forks_count * 3 + Math.max(0, 3 - daysSinceUpdate / 120);
}

function renderDashboard({ user, repositories, languageTotals, contributions, events }) {
  const owned = repositories.filter((repository) => !repository.fork);
  const totals = owned.reduce((sum, repository) => ({ stars: sum.stars + repository.stargazers_count, forks: sum.forks + repository.forks_count }), { stars: 0, forks: 0 });
  const languages = languageRows(languageTotals);
  const topRepositories = [...owned].sort((first, second) => repositoryScore(second) - repositoryScore(first)).slice(0, 5);
  const recentEvents = events.map((event) => ({ ...event, label: activityLabel(event) })).filter((event) => event.label && event.repo?.name).slice(0, 5);
  let cursor = contributions ? 494 : 306;
  const languageHeight = languages.length ? 45 + languages.length * 23 : 0;
  const repositoryHeight = topRepositories.length ? 48 + topRepositories.reduce((height, repository) => height + (repository.description ? 56 : 40), 0) : 0;
  const activityHeight = recentEvents.length ? 42 + recentEvents.length * 30 : 0;
  const height = cursor + Math.max(languageHeight, repositoryHeight) + (languages.length || topRepositories.length ? 18 : 0) + activityHeight + (recentEvents.length ? 18 : 0) + 112;
  const metric = (x, label, value) => `<text x="${x}" y="226" class="metric">${formatNumber(value)}</text><text x="${x}" y="249" class="caption">${label}</text>`;
  const contributionSection = contributions ? `<text x="42" y="306" class="section">CONTRIBUTIONS</text>
    <rect x="42" y="324" width="916" height="150" rx="12" class="card"/>
    <text x="64" y="352" class="caption">Last 12 months</text>
    <text x="64" y="378" class="value">${formatNumber(contributions.contributionCalendar.totalContributions)}</text><text x="64" y="400" class="caption">Total contributions</text>
    <text x="210" y="378" class="value">${formatNumber(contributions.totalCommitContributions)}</text><text x="210" y="400" class="caption">Commit contributions</text>
    <text x="384" y="378" class="value">${formatNumber(contributions.totalPullRequestContributions)}</text><text x="384" y="400" class="caption">Pull request contributions</text>
    <text x="592" y="378" class="value">${formatNumber(contributions.totalIssueContributions)}</text><text x="592" y="400" class="caption">Issue contributions</text>
    <text x="760" y="378" class="value">${formatNumber(contributions.totalPullRequestReviewContributions)}</text><text x="760" y="400" class="caption">Code review contributions</text>
    ${heatmap(contributions.days, 64, 418)}<text x="64" y="458" class="caption">Less</text><rect x="98" y="450" width="8" height="8" rx="2" fill="#24283b"/><rect x="110" y="450" width="8" height="8" rx="2" fill="#1f6f4a"/><rect x="122" y="450" width="8" height="8" rx="2" fill="#2ea043"/><rect x="134" y="450" width="8" height="8" rx="2" fill="#56d364"/><rect x="146" y="450" width="8" height="8" rx="2" fill="#9be9a8"/><text x="160" y="458" class="caption">More</text>` : "";
  const languageSection = languages.length ? `<text x="42" y="${cursor}" class="section">LANGUAGE DISTRIBUTION</text><rect x="42" y="${cursor + 18}" width="430" height="${languageHeight - 10}" rx="12" class="card"/>${languages.map((language, index) => {
    const y = cursor + 48 + index * 23;
    return `<text x="64" y="${y}" class="label">${escapeXml(language.name)}</text><rect x="190" y="${y - 10}" width="210" height="9" rx="4.5" fill="#24283b"/><rect x="190" y="${y - 10}" width="${(language.percentage * 2.1).toFixed(1)}" height="9" rx="4.5" fill="${language.color}"/><text x="420" y="${y}" text-anchor="end" class="caption">${language.percentage.toFixed(1)}%</text>`;
  }).join("")}` : "";
  const repositorySection = topRepositories.length ? `<text x="500" y="${cursor}" class="section">TOP REPOSITORIES</text><rect x="500" y="${cursor + 18}" width="458" height="${repositoryHeight - 10}" rx="12" class="card"/>${topRepositories.map((repository, index) => {
    const y = cursor + 48 + topRepositories.slice(0, index).reduce((offset, item) => offset + (item.description ? 56 : 40), 0);
    const description = repository.description ? `<text x="522" y="${y + 17}" class="caption">${escapeXml(truncate(repository.description, 58))}</text>` : "";
    const metaY = repository.description ? y + 36 : y + 18;
    const language = repository.language ? `${escapeXml(repository.language)} · ` : "";
    return `<a href="${escapeXml(repository.html_url)}"><text x="522" y="${y}" class="repo">${escapeXml(repository.name)}</text></a>${description}<text x="522" y="${metaY}" class="caption">${language}★ ${formatNumber(repository.stargazers_count)} · Forks ${formatNumber(repository.forks_count)} · ${formatDate(repository.updated_at)}</text>`;
  }).join("")}` : "";
  cursor += Math.max(languageHeight, repositoryHeight) + (languages.length || topRepositories.length ? 18 : 0);
  const activitySection = recentEvents.length ? `<text x="42" y="${cursor}" class="section">RECENT PUBLIC ACTIVITY</text><rect x="42" y="${cursor + 18}" width="916" height="${activityHeight - 10}" rx="12" class="card"/>${recentEvents.map((event, index) => {
    const y = cursor + 48 + index * 30;
    return `<circle cx="64" cy="${y - 5}" r="4" fill="#7aa2f7"/><text x="78" y="${y}" class="label">${escapeXml(event.label)}</text><text x="78" y="${y + 16}" class="caption">${escapeXml(event.repo.name)} · ${formatDate(event.created_at)}</text>`;
  }).join("")}` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${height}" viewBox="0 0 1000 ${height}" role="img" aria-labelledby="title description">
  <title id="title">Rathanak Phan GitHub Statistics</title><desc id="description">A GitHub API-generated portfolio dashboard with profile, contribution, language, repository, and public activity data.</desc>
  <style>.title{font:700 27px Arial,sans-serif;fill:#c0caf5}.subtitle{font:400 14px Arial,sans-serif;fill:#a9b1d6}.section{font:700 15px Arial,sans-serif;letter-spacing:1px;fill:#7aa2f7}.metric{font:700 25px Arial,sans-serif;fill:#c0caf5}.value{font:700 21px Arial,sans-serif;fill:#c0caf5}.label{font:600 12px Arial,sans-serif;fill:#c0caf5}.caption{font:400 11px Arial,sans-serif;fill:#a9b1d6}.repo{font:700 13px Arial,sans-serif;fill:#bb9af7;text-decoration:underline}.card{fill:#1f2335;stroke:#292e42}</style>
  <rect width="1000" height="${height}" rx="18" fill="#1a1b26"/><rect x="20" y="20" width="960" height="${height - 40}" rx="14" fill="#16161e" stroke="#414868"/>
  <a href="${escapeXml(user.html_url)}"><text x="42" y="62" class="title">📊 GitHub Statistics</text></a><text x="42" y="86" class="subtitle">${escapeXml(user.name || "Rathanak Phan")} · @${USERNAME}</text><text x="958" y="62" text-anchor="end" class="caption">Last updated: ${utcTimestamp()}</text><text x="958" y="86" text-anchor="end" class="caption">github.com/${USERNAME}</text><line x1="42" y1="108" x2="958" y2="108" stroke="#414868"/>
  <text x="42" y="150" class="section">PROFILE OVERVIEW</text><rect x="42" y="168" width="916" height="106" rx="12" class="card"/>
  ${metric(66, "Repositories", owned.length)}${metric(244, "Followers", user.followers)}${metric(406, "Following", user.following)}${metric(566, "Total stars", totals.stars)}${metric(746, "Total forks", totals.forks)}
  ${contributionSection}${languageSection}${repositorySection}${activitySection}
  <line x1="42" y1="${height - 78}" x2="958" y2="${height - 78}" stroke="#414868"/><text x="42" y="${height - 52}" class="section">CURRENT FOCUS</text><text x="42" y="${height - 32}" class="subtitle">Full-Stack Web Development · Node.js · NestJS · React · Vue.js · PostgreSQL · Docker</text><text x="958" y="${height - 32}" text-anchor="end" class="caption">Generated automatically with GitHub Actions</text>
</svg>`;
}

async function main() {
  const [user, repositories, events] = await Promise.all([
    request(`https://api.github.com/users/${USERNAME}`),
    fetchAllRepositories(),
    request(`https://api.github.com/users/${USERNAME}/events/public?per_page=30`).catch((error) => {
      console.warn(`Skipped public activity: ${error.message}`);
      return [];
    }),
  ]);
  const [languageTotals, contributions] = await Promise.all([fetchLanguages(repositories), fetchContributions()]);
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir("profile", { recursive: true });
  await writeFile(OUTPUT_PATH, renderDashboard({ user, repositories, languageTotals, contributions, events }));
  console.log(`Generated ${OUTPUT_PATH} from ${repositories.length} repositories.`);
}

main().catch((error) => {
  console.error(`Statistics generation failed: ${error.message}`);
  process.exitCode = 1;
});
