---
id: "cav-users-soft-deletes"
kind: "caveat"
title: "Soft deletes in dim_users"
target_tables: ["dim_users", "fct_orders"]
tags: ["users", "retention", "joins"]
author: "data-lead"
created_at: "2026-10-18"
---

### Problem

`dim_users` keeps historical records of deleted or churned accounts where `deleted_at IS NOT NULL` or `is_deleted = true`.
If you join `dim_users` directly without filtering, active user counts and retention cohorts will be artificially inflated.

### Solution / Recommended Filter

Always include `deleted_at IS NULL` when querying active users or joining on user dimensions:

```sql
SELECT
  u.id,
  u.signup_date,
  count(o.id) as order_count
FROM dim_users u
LEFT JOIN fct_orders o ON u.id = o.user_id
WHERE u.deleted_at IS NULL
GROUP BY 1, 2;
```
