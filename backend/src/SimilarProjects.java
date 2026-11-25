import java.sql.Connection;
import java.sql.SQLException;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** Read-only, project-level comparison for the sales request preview. */
final class SimilarProjects {
    private static final int MIN_SUMMARY_LENGTH = 20;
    private static final int MIN_SCORE = 75;
    private static final double MIN_SUMMARY_COSINE = 0.55;
    private static final double QUESTION_GROUP_SUMMARY_COSINE = 0.75;
    private static final int MAX_MATCHES = 3;
    private static final Pattern SPACE = Pattern.compile("[\\s\\p{Z}]+");
    // Terms of recruitment often repeat verbatim across unrelated project descriptions.
    private static final Pattern RECRUITMENT_FIELDS = Pattern.compile(
            "(?:【|\\[|(?m:^)[\\t ]*)(?:募集人数|最寄(?:り)?駅|勤務場所|勤務地|作業場所|単価|募集期間|"
            + "精算(?:幅)?|参画時期|面談回数|商流)[\\t ]*(?:】|\\]|:)[^\\r\\n【\\[]*");
    private static final Pattern BOILERPLATE = Pattern.compile(
            "(?:いつも)?(?:大変)?お世話になっております|(?:いつも)?お世話になります"
            + "|(?:下記|以下|本日)(?:の)?案件(?:情報)?を(?:ご)?(?:紹介|案内|共有)(?:いたします|致します|します)"
            + "|(?:案件(?:情報)?の)?ご(?:紹介|案内)です"
            + "|(?:ご(?:確認|検討|提案)(?:の(?:ほど|程))?)?(?:何卒|どうぞ|引き続き)?よろしく(?:お願い(?:いたします|致します|申し上げます|します))?"
            + "|(?:【|\\[|^|\\n)\\s*(?:案件名|案件概要|業務内容|作業内容|募集人数|必須(?:スキル)?|尚可(?:スキル)?|スキル|"
            + "最寄(?:り)?駅|勤務場所|勤務地|作業場所|単価|期間|精算幅|参画時期|面談回数|商流|備考)\\s*(?:】|\\]|[:：])");
    // Separate commonly copied technologies so their grams cannot dominate business-specific text.
    private static final Pattern COMMON_TECH = Pattern.compile(
            "(?<![a-z0-9])(?:java(?:script)?|typescript|sql|postgres(?:ql)?|mysql|oracle|python|php|"
            + "react|vue|angular|spring(?:\\s*boot)?|aws|azure|gcp|linux|windows|html|css|git|docker|"
            + "kubernetes|c\\+\\+|c#|\\.net)(?![a-z0-9])");
    private static final Pattern SEPARATORS = Pattern.compile("[^\\p{L}\\p{M}\\p{N}.+#]+");
    private static final Pattern MATERIAL = Pattern.compile("[^\\p{L}\\p{N}]+");
    private static final Pattern COMPANY_FORM = Pattern.compile(
            "^(?:株式会社|有限会社|合同会社|\\([株有同]\\))|(?:株式会社|有限会社|合同会社|\\([株有同]\\))$");

    private record Content(String title, String summary, String upper, String end, boolean enoughSummary) {
        static Content from(String title, String summary, String upper, String end) {
            String withoutTerms = RECRUITMENT_FIELDS.matcher(fold(summary)).replaceAll(" ");
            String cleaned = BOILERPLATE.matcher(withoutTerms).replaceAll(" ");
            String material = MATERIAL.matcher(COMMON_TECH.matcher(cleaned).replaceAll(" ")).replaceAll("");
            return new Content(compact(fold(title)), summaryText(cleaned), company(upper), company(end),
                    material.codePointCount(0, material.length()) >= MIN_SUMMARY_LENGTH);
        }
    }

    private record Candidate(String id, boolean own, String salesName, String name, String summary, Content content) {}
    private record QuestionProject(String id, Content content, Map<String, String> companies, Set<String> endCompanies) {}
    record QuestionGroupResult(List<String> projectIds, String companyName) {}
    private record Match(Candidate candidate, int score, List<String> reasons) {
        Map<String, Object> response() {
            var result = new LinkedHashMap<String, Object>();
            result.put("scope", candidate.own ? "own" : "other");
            result.put("salesName", candidate.salesName);
            result.put("score", score);
            result.put("reasons", reasons);
            result.put("projectId", candidate.id);
            result.put("projectName", candidate.name);
            result.put("summary", candidate.summary);
            return result;
        }
    }

    private static String fold(String value) {
        return Normalizer.normalize(value, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT);
    }

    private static String compact(String value) {
        return SEPARATORS.matcher(value).replaceAll("");
    }

    private static String summaryText(String value) {
        // compact() strips every literal pipe from input; alternating segments mark common technology terms.
        var terms = COMMON_TECH.matcher(value);
        var result = new StringBuilder();
        int start = 0;
        while (terms.find()) {
            result.append(compact(value.substring(start, terms.start())))
                    .append('|').append(compact(terms.group())).append('|');
            start = terms.end();
        }
        return result.append(compact(value.substring(start))).toString();
    }

    private static String company(String value) {
        return SPACE.matcher(fold(value)).replaceAll("").replace("(株)", "株式会社")
                .replace("(有)", "有限会社").replace("(同)", "合同会社");
    }

    private static Map<String, String> namedCompanies(String field) {
        var companies = new LinkedHashMap<String, String>();
        for (String name : field.split("→")) {
            String key = COMPANY_FORM.matcher(SPACE.matcher(fold(name)).replaceAll("")).replaceAll("");
            if (!key.isEmpty()) companies.putIfAbsent(key, name.strip());
        }
        return companies;
    }

    private static Map<String, Integer> grams(String value) {
        Map<String, Integer> result = new HashMap<>();
        String[] segments = value.split("\\|");
        for (int part = 0; part < segments.length; part++) {
            int[] letters = segments[part].codePoints().toArray();
            String prefix = part % 2 == 0 ? "" : "|";
            for (int start = 0; start < letters.length - 1; start++) {
                for (int length = 2; length <= 3 && start + length <= letters.length; length++) {
                    result.merge(prefix + new String(letters, start, length), 1, Integer::sum);
                }
            }
        }
        return result;
    }

    /** A gram contributes once per document to IDF and logarithmically per occurrence to TF. */
    private static final class Corpus {
        private final Map<String, Integer> documentFrequency = new HashMap<>();
        private int count;

        void include(String value) {
            count++;
            for (String gram : grams(value).keySet()) documentFrequency.merge(gram, 1, Integer::sum);
        }

        double weight(String gram, int frequency) {
            double idf = 1 + Math.log((count + 1.0) / (documentFrequency.getOrDefault(gram, 0) + 1.0));
            double importance = gram.charAt(0) == '|' ? 0.25 : 1;
            return (1 + Math.log(frequency)) * idf * importance;
        }

        Map<String, Double> unitVector(String value) {
            var weights = new HashMap<String, Double>();
            double squared = 0;
            for (var entry : grams(value).entrySet()) {
                double w = weight(entry.getKey(), entry.getValue());
                weights.put(entry.getKey(), w);
                squared += w * w;
            }
            double norm = Math.sqrt(squared);
            if (norm > 0) weights.replaceAll((key, w) -> w / norm);
            return weights;
        }

        double cosine(Map<String, Double> draft, String existing) {
            double dot = 0, squared = 0;
            for (var entry : grams(existing).entrySet()) {
                double w = weight(entry.getKey(), entry.getValue());
                squared += w * w;
                dot += w * draft.getOrDefault(entry.getKey(), 0.0);
            }
            return squared == 0 ? 0 : Math.min(1, dot / Math.sqrt(squared));
        }
    }

    private static double cosine(Map<String, Double> left, Map<String, Double> right) {
        Map<String, Double> smaller = left.size() <= right.size() ? left : right;
        Map<String, Double> larger = smaller == left ? right : left;
        double dot = 0;
        for (var entry : smaller.entrySet()) dot += entry.getValue() * larger.getOrDefault(entry.getKey(), 0.0);
        return Math.min(1, dot);
    }

    private static final class QuestionGroup {
        private final List<QuestionProject> members = new ArrayList<>();
        private final Map<String, String> commonCompanies;

        QuestionGroup(QuestionProject first) {
            commonCompanies = new LinkedHashMap<>(first.companies);
            members.add(first);
        }

        boolean accepts(QuestionProject project, Map<String, Map<String, Double>> summaries) {
            if (!project.content.enoughSummary || disjoint(commonCompanies.keySet(), project.companies.keySet())) return false;
            for (QuestionProject existing : members) {
                if (!existing.content.enoughSummary) return false;
                if (!existing.endCompanies.isEmpty() && !project.endCompanies.isEmpty()
                        && disjoint(existing.endCompanies, project.endCompanies)) return false;
                if (cosine(summaries.get(existing.id), summaries.get(project.id)) < QUESTION_GROUP_SUMMARY_COSINE) return false;
            }
            return true;
        }

        private static boolean disjoint(Set<String> left, Set<String> right) {
            return left.stream().noneMatch(right::contains);
        }

        void add(QuestionProject project) {
            commonCompanies.keySet().retainAll(project.companies.keySet());
            members.add(project);
        }

        QuestionGroupResult result() {
            return new QuestionGroupResult(members.stream().map(QuestionProject::id).toList(),
                    commonCompanies.values().stream().findFirst().orElse(null));
        }
    }

    static List<QuestionGroupResult> questionGroups(Connection connection) throws SQLException {
        List<QuestionProject> projects = new ArrayList<>();
        Corpus summaries = new Corpus();
        String sql = """
                SELECT p.id, p.notes, p.upper_company, p.prime_company, p.end_company
                FROM projects p
                WHERE EXISTS (SELECT 1 FROM interview_questions q WHERE q.project_id=p.id)
                ORDER BY p.id
                """;
        try (var statement = connection.prepareStatement(sql)) {
            statement.setQueryTimeout(10);
            statement.setFetchSize(100);
            try (var rows = statement.executeQuery()) {
                while (rows.next()) {
                    Content content = Content.from("", rows.getString("notes"), "", "");
                    summaries.include(content.summary);
                    Map<String, String> ends = namedCompanies(rows.getString("end_company"));
                    var companies = new LinkedHashMap<>(ends);
                    namedCompanies(rows.getString("prime_company")).forEach(companies::putIfAbsent);
                    namedCompanies(rows.getString("upper_company")).forEach(companies::putIfAbsent);
                    projects.add(new QuestionProject(rows.getString("id"), content, companies, ends.keySet()));
                }
            }
        }

        Map<String, Map<String, Double>> vectors = new HashMap<>();
        for (QuestionProject project : projects) {
            if (project.content.enoughSummary) vectors.put(project.id, summaries.unitVector(project.content.summary));
        }
        List<QuestionGroup> groups = new ArrayList<>();
        for (QuestionProject project : projects) {
            QuestionGroup match = groups.stream().filter(group -> group.accepts(project, vectors)).findFirst().orElse(null);
            if (match == null) groups.add(new QuestionGroup(project));
            else match.add(project);
        }
        return groups.stream().map(QuestionGroup::result).toList();
    }

    static List<Map<String, Object>> find(Connection connection, String viewer, String title, String summary,
                                           String upper, String end) throws SQLException {
        Content draft = Content.from(title, summary, upper, end);
        if (!draft.enoughSummary) return List.of();

        List<Candidate> candidates = new ArrayList<>();
        Corpus titles = new Corpus(), summaries = new Corpus();
        String sql = """
                SELECT p.id, p.name, p.notes, p.upper_company, p.end_company,
                       p.sales_id = ? AS own, u.display_name
                FROM projects p JOIN app_users u ON u.id = p.sales_id
                """;
        try (var statement = connection.prepareStatement(sql)) {
            statement.setString(1, viewer);
            statement.setFetchSize(100);
            try (var rows = statement.executeQuery()) {
                while (rows.next()) {
                    String name = rows.getString("name"), notes = rows.getString("notes");
                    Content existing = Content.from(name, notes, rows.getString("upper_company"), rows.getString("end_company"));
                    titles.include(existing.title);
                    summaries.include(existing.summary);
                    if (!existing.enoughSummary) continue;
                    boolean own = rows.getBoolean("own");
                    candidates.add(new Candidate(rows.getString("id"), own, rows.getString("display_name"), name, notes, existing));
                }
            }
        }
        Map<String, Double> draftTitle = titles.unitVector(draft.title), draftSummary = summaries.unitVector(draft.summary);
        var best = new ArrayList<Match>();
        var order = Comparator.comparingInt(Match::score).reversed().thenComparing(match -> match.candidate.id);
        for (Candidate candidate : candidates) {
            Content existing = candidate.content;
            double summarySimilarity = summaries.cosine(draftSummary, existing.summary);
            if (summarySimilarity < MIN_SUMMARY_COSINE) continue;
            // A one-character title has no 2-grams but can still be an exact match.
            double titleSimilarity = !draft.title.isEmpty() && draft.title.equals(existing.title)
                    ? 1 : titles.cosine(draftTitle, existing.title);
            double points = 65 * summarySimilarity + 15 * titleSimilarity;
            int possible = 80;
            var reasons = new ArrayList<String>();
            reasons.add("業務内容が類似");
            if (titleSimilarity >= 0.55) reasons.add("案件名が類似");
            if (!draft.upper.isEmpty() && !existing.upper.isEmpty()) {
                possible += 10;
                boolean equal = draft.upper.equals(existing.upper);
                if (equal) points += 10;
                reasons.add(equal ? "上位会社が一致" : "上位会社が異なる");
            }
            if (!draft.end.isEmpty() && !existing.end.isEmpty()) {
                possible += 10;
                boolean equal = draft.end.equals(existing.end);
                if (equal) points += 10;
                reasons.add(equal ? "エンド企業が一致" : "エンド企業が異なる");
            }
            int score = (int) Math.round(points * 100 / possible);
            if (score < MIN_SCORE) continue;
            best.add(new Match(candidate, score, reasons));
            best.sort(order);
            if (best.size() > MAX_MATCHES) best.remove(MAX_MATCHES);
        }
        return best.stream().map(Match::response).toList();
    }
}
