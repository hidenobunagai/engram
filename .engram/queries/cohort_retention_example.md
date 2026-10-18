---
id: "qry-cohort-retention"
kind: "query"
title: "Standard Monthly Cohort Retention"
target_tables: ["fct_orders", "dim_users"]
tags: ["retention", "cohorts", "gold-standard"]
author: "senior-analyst"
created_at: "2026-10-18"
---

### Purpose

Calculates N-month retention rates based on initial order month. Peer-reviewed and used across corporate executive reporting.

```sql
WITH cohort_items AS (
  SELECT
    user_id,
    min(date_trunc('month', order_date)) as cohort_month
  FROM fct_orders
  WHERE status = 'completed'
  GROUP BY 1
),
user_activities AS (
  SELECT
    o.user_id,
    date_trunc('month', o.order_date) as activity_month
  FROM fct_orders o
  WHERE o.status = 'completed'
  GROUP BY 1, 2
)
SELECT
  c.cohort_month,
  (extract(year from a.activity_month) - extract(year from c.cohort_month)) * 12 +
  (extract(month from a.activity_month) - extract(month from c.cohort_month)) as month_number,
  count(distinct a.user_id) as active_users
FROM cohort_items c
JOIN user_activities a ON c.user_id = a.user_id
GROUP BY 1, 2
ORDER BY 1, 2;
```
