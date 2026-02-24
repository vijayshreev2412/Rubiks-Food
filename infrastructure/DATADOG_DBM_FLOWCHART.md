# Datadog Database Monitoring (DBM) Setup Flowchart

This guide provides a customer-friendly process flow for setting up Datadog DBM across common database types.

## End-to-end DBM setup flow

```mermaid
flowchart TD
    A[Start: Need database performance visibility] --> B{Where is the database hosted?}
    B -->|Self-managed host or VM| C[Deploy Datadog Agent near the database]
    B -->|Managed cloud database| D[Connect cloud integration AWS Azure GCP and deploy Agent in same network]
    C --> E{Database engine type}
    D --> E

    E -->|PostgreSQL| P1[Create monitoring user and grant pg_monitor]
    P1 --> P2[Enable pg_stat_statements and related parameters]
    P2 --> P3[Set postgres integration config with dbm: true]
    P3 --> V

    E -->|MySQL or MariaDB| M1[Create read-only monitoring user]
    M1 --> M2[Enable performance_schema]
    M2 --> M3[Set mysql integration config with dbm: true]
    M3 --> V

    E -->|SQL Server| S1[Create login with VIEW SERVER STATE]
    S1 --> S2[Enable Query Store where required]
    S2 --> S3[Set sqlserver integration config with dbm: true]
    S3 --> V

    E -->|Oracle| O1[Create monitoring user with catalog view access]
    O1 --> O2[Confirm performance views are available]
    O2 --> O3[Set oracle integration config with dbm: true]
    O3 --> V

    E -->|MongoDB| G1[Use Datadog Agent 7.58+ and direct node connection]
    G1 --> G2[Create monitoring role with clusterMonitor and read permissions]
    G2 --> G3[Set mongodb integration config with dbm: true]
    G3 --> V

    E -->|Other engine| U1[Check Datadog support matrix]
    U1 --> U2{DBM supported?}
    U2 -->|No| U3[Use Datadog integration plus logs and APM until DBM support is available]
    U3 --> Z[End]
    U2 -->|Yes| V

    V[Validate network access and credentials] --> W[Enable query metrics and waits collection]
    W --> X[Restart or reload DB and Agent configs if needed]
    X --> Y[Verify data in Datadog DBM pages]
    Y --> AA[Create alerts dashboards and service ownership tags]
    AA --> AB[Customer handoff with runbook and escalation path]
    AB --> Z[End]
```

## What changes by database type

| Database type | Must-have telemetry feature | Typical minimum read-only access | Managed service note |
| --- | --- | --- | --- |
| PostgreSQL | `pg_stat_statements` | `pg_monitor` (or equivalent least-privilege grants) | On RDS/Aurora PostgreSQL, use parameter groups to enable extension settings. |
| MySQL/MariaDB | `performance_schema` | Read access to performance schema and status views | On RDS/Aurora MySQL, enable required parameters in DB parameter groups. |
| SQL Server | Query Store (recommended) | `VIEW SERVER STATE` and related read-only metadata access | On Azure SQL/Amazon RDS SQL Server, apply equivalent permissions and network access from Agent. |
| Oracle | Performance/catalog dynamic views | `CREATE SESSION` plus catalog performance view access | For managed Oracle services, map grants to provider-specific role capabilities. |
| MongoDB | DBM query and cluster metrics collection | `clusterMonitor` plus read access (`read` or `readAnyDatabase` depending on scope) | MongoDB Atlas DBM requires supported tiers (for example, M10+; shared/serverless tiers are not supported). |
| Other engines | Vendor-specific diagnostics | Least-privilege read-only monitoring role | If DBM is not supported, use integrations, logs, and APM traces first. |

## Customer-facing talk track (simple)

1. **Decide scope**: database type, environment, and business-critical services.
2. **Prepare security**: create a read-only monitoring user and store credentials securely.
3. **Enable telemetry**: turn on engine-specific performance features.
4. **Connect Datadog**: deploy Agent and set integration config with `dbm: true`.
5. **Validate**: confirm query performance, blocking or lock signals, waits (where applicable), and host metrics in DBM.
6. **Operationalize**: build dashboards, define alerts, and document support ownership.

## Suggested validation checklist

- DB host appears in Datadog Infrastructure.
- Database instance appears in Datadog Database Monitoring.
- Top queries show latency and execution volume.
- Wait events or lock analysis panels have data.
- Alerts trigger for high latency, saturation, and error spikes.
- Dashboard links are shared with customer stakeholders.
