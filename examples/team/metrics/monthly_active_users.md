---
id: "met-mau"
kind: "metric"
title: "Monthly Active Users (MAU)"
summary: "Distinct users with a qualifying event in the calendar month, internal accounts excluded."
target_tables: ["fct_user_activity", "dim_users"]
tags: ["kpi", "engagement", "executive"]
author: "growth-analyst"
created_at: "2026-10-18"
---

### Business Definition

A user who triggered at least one distinct qualifying event (view, click, search, purchase) within the rolling 30-day window or calendar month.
Excludes internal test accounts (`is_internal = true`) and bot traffic.

### Canonical SQL Logic

```sql
SELECT
  date_trunc('month', a.event_time) as activity_month,
  count(distinct a.user_id) as mau
FROM fct_user_activity a
JOIN dim_users u ON a.user_id = u.id
WHERE u.is_internal = false
  AND a.event_type IN ('page_view', 'checkout', 'search')
GROUP BY 1
ORDER BY 1 DESC;
```
