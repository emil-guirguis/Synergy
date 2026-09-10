# MeterIt Pro — Application Sheet

**Electricity Meter Management** · Application Sheet  
Document: MIP-AS-001 · Rev B · © 2026 MeterIt Pro  
www.meteritpro.com | info@meteritpro.com

> Generated from `src/pages*.html` by `src/to-markdown.mjs` — edit the sources,
> not this file. Screenshots are embedded in the HTML build and appear here as
> `_[screenshot: …]_` notes.

---

## Page 01 — Cloud Electricity Meter Management

MeterIt Pro is a cloud electricity meter data management platform for meter manufacturers, resellers, utilities and facility teams. Capture readings, validate them, publish reports and query the whole portfolio in plain language — one site or hundreds, from any browser.

- **24/7** — Real-time access to every reading
- **100%** — Cloud-hosted — no on-prem servers
- **15 min** — Typical capture interval per register
- **RBAC** — Eight roles, isolated per tenant

### Measured and retained

`kWh` · `kVA` · `kVA per phase` · `Amps` · `Amps per phase` · `Physical meters` · `Virtual meters` · `BACnet` · `IP`

### Full visibility

- Live dashboards — no manual export
- Desktop, tablet or phone
- Read-only views for stakeholders

### Built for scale

- Hundreds of locations, one portfolio
- Register-level, not building-level
- Scheduled reports by email

### Secure by default

- HTTPS / TLS end to end
- Row-level tenant isolation
- Authentication events logged

_[screenshot: **Portfolio home** — energy today, peak demand, active meters and open alerts at a glance, with recent activity and favourite registers alongside.]_

---

## Page 02 — Core Capabilities

One platform for capture, validation, analytics, alerting and reporting — purpose-built for electricity metering rather than adapted from generic BMS tooling.

- **Smart meter capture** — Mobile-friendly workflows walk technicians through every reading. Physical and virtual meters, captured at the register and circuit level.
- **Validation & anomaly detection** — Quality checks flag anomalies and missing intervals before reports go out, so the data stays audit-ready.
- **Energy analytics** — Usage trends, peak demand and cost efficiency across every meter, on dashboards you compose yourself.
- **Multi-site portfolio** — Readings across hundreds of locations from one dashboard — built for ESCOs, property managers and facility teams.
- **Alerts & notifications** — Threshold, no-reading and zero-reading rules on any register, with in-app and email delivery.
- **Scheduled reporting** — Cost and revenue reports on a cron schedule, delivered as HTML, PDF or CSV with per-recipient delivery logging.
- **Zenith AI assistant** — Plain-language querying over the whole portfolio. Built for AI integration from day one, not retrofitted.
- **On-site sync server** — A sealed Linux appliance that keeps metering through an internet outage and back-fills the cloud on reconnect.

### What a deployment looks like

> _Diagram: Meters connect over BACnet and IP to an on-site sync server, which streams to the MeterIt Pro cloud, which serves browsers, scheduled email reports and the Zenith assistant._

### Where it fits

- **Meter manufacturers & resellers** — Ship hardware with a data platform already attached, branded per tenant, instead of leaving the customer to source one.
- **ESCOs & property managers** — Recover costs per tenant and per circuit, with the interval evidence to back an invoice when it is questioned.
- **Utilities & facility teams** — Watch demand across a whole estate and catch a stalled meter the same day rather than at month end.

Nothing in the stack above is optional-extra licensing: capture, dashboards, reporting, alerting and the assistant are the same product. The only hardware decision is whether a site needs its own sync-server appliance.

---

## Page 03 — Meters & Registers

Every meter is modelled with its own registers, so consumption is tracked at the circuit level rather than the building level. A register is the unit everything else attaches to — readings, graphs, alert rules and favourites.

### Meter types

- **Physical meter** — Bound to a device on a sync server. MeterIt Pro polls it for live readings on the capture interval.
- **Virtual meter** — Derived from other meters — mains less lighting, tenant sub-totals, aggregated sites. No hardware, no extra install.

### Per-meter registers

- Multiple registers per meter
- Named channels
- Per-register readings, graphs and alerts
- Serial, IP, sync server and live status

### Setup sequence

1. Name the meter and assign its location
2. Choose physical or virtual
3. Assign device model and sync server
4. Map registers / elements
5. Set alert rules on any register
6. Assign role-based user access

_[screenshot: **Meter list** — physical and virtual meters side by side, each tied to a device model, IP address, sync server and live status.]_

---

## Page 04 — Metering Data Captured

Per register, per interval — the full electrical picture, timestamped and retained. Every parameter below is queryable, chartable, alertable and export-ready as CSV or PDF.

| Parameter | Unit | Resolution | Notes |
|---|---|---|---|
| **Energy** | kWh | 15-min interval | Cumulative and calculated consumption |
| **Apparent power** | kVA | 15-min interval | Total load |
| **Apparent power, per phase** | kVA | 15-min interval | Phase A / B / C |
| **Current** | A | 15-min interval | Total current draw |
| **Current, per phase** | A | 15-min interval | Phase A / B / C |
| **Timestamp** | ISO 8601 | per reading | Local site time, retained for audit |

### Getting data out

- **CSV** — raw intervals for billing and analysis
- **PDF** — formatted for audits and clients
- **Email** — one-click send, or on a schedule
- **REST API** — programmatic access per tenant

### Data quality

- Missing intervals surfaced, not silently skipped
- Zero and stalled channels raise their own rule type
- Buffered readings back-fill in correct time order
- Readings are append-only and audit-retained

_[screenshot: **Register readings** — kWh, calculated kWh, kVA, per-phase kVA and per-phase amperage at 15-minute intervals, with export and email on the same view.]_

---

## Page 05 — Dashboards & Analytics

Compose dashboards from configurable chart widgets. Range, chart type, granularity and aggregation are set per widget — so each team builds the exact view it needs instead of negotiating over one shared layout.

### Per-widget controls

| Spec | Value |
|------|-------|
| Range | since install · daily · custom |
| Granularity | down to 15 min |
| Aggregation | max · min · avg · sum |
| Chart type | bar · line · area · pie · table |
| Actions | refresh · export · email |

### Composition

- Multiple dashboards per user
- Drag-and-drop widget layout
- Any register or meter as a series
- Favourites pinned to the portfolio home
- Read-only sharing with stakeholders

_[screenshot: **Custom dashboard** — a Peak kW widget with its range, chart type, granularity and aggregation exposed directly on the widget.]_

---

## Page 06 — Scheduled Reports

Dashboards are for looking; reports are for sending. Define a report once — meters, window, shape, format, recipients — and the platform runs it on a cron schedule and records what actually reached each address.

### Report definition

| Spec | Value |
|------|-------|
| Report type | cost · revenue |
| Schedule | cron expression |
| Time frame | today · weekly · monthly · yearly · custom |
| Grouping | hourly · daily · weekly · monthly |
| Visualization | bar · line · pie · csv |
| Attach as | html · pdf · csv |
| Meter selection | any meters / registers |
| Recipients | multiple addresses |
| State | active / inactive per report |
| Cadence | recurring, or one-time |

### Run and delivery pipeline

> _Diagram: A report definition fires on its cron schedule; the run is recorded as success or failed with an error message; each recipient then gets its own delivery record of sent, delivered or failed._

### Why the delivery log matters

- A run that succeeded is not the same as an email that arrived
- Failures keep the error text, per address
- Execution history is indexed by report and by date
- Deleting a report cascades its history and its logs

### Typical uses

- Monthly tenant cost recovery, grouped daily
- Weekly revenue summary to the account manager
- Yearly consumption CSV for the auditor
- Custom-window PDF after a tariff change

### Two reports, fully specified

| Report | Type | Window | Grouping | Shape | Goes out as |
|---|---|---|---|---|---|
| **Tenant cost recovery** — active | cost | monthly | daily | bar | pdf |
| **Portfolio revenue summary** — active | revenue | weekly | daily | line | html |

_Both are ordinary records — editable, disableable, and duplicable per client. A csv visualization with a csv attachment produces a raw interval extract instead of a chart._

Reports run server-side on the platform's own schedule, so nothing depends on a browser being open or a workstation being awake. Recipients do not need MeterIt Pro accounts.

---

## Page 07 — Alerts & Notifications

Define rules once and the platform watches every register around the clock — so a stalled meter or a runaway load is caught before the client notices it.

### Rule types

| Rule type | Fires when | What it catches |
|---|---|---|
| **Custom** threshold | A parameter crosses the configured threshold on a register | Runaway load, demand overshoot, tariff breach |
| **No reading** silence | No reading arrives for a register within the expected interval | Dead comms, offline sync server, decommissioned device |
| **Zero reading** stalled | A register reports zero where consumption is expected | Dead CT, stalled channel, mis-wired circuit |

### Delivery

- In-app banner on the platform
- Email with a link straight to the meter in alarm
- Threshold breach, over-interval and over-time conditions
- Scheduled scans clear stale notifications

### Management

- Active or inactive per rule — no deleting to silence one
- Full notification history retained
- Rules attach to any register, on any meter
- Create, read, update and delete gated by permission

_[screenshot: **Notification rules** — custom, no-reading and zero-reading rule types, each toggled active or inactive per register.]_

---

## Page 08 — Zenith AI Assistant

Query meters, readings and alerts in plain language — no report to build, no filters to configure. Zenith reads across the portfolio, inside the asking user's own tenant and permissions, and answers in seconds.

### Questions it answers

- Which meters haven't reported in 48 hours?
- What is my total consumption today?
- Which alert rules triggered this week?
- Summarize peak demand across all sites.

### How it stays trustworthy

- Scoped to the caller's tenant — never across tenants
- Reads the same records the UI shows, not a stale copy
- Suggested prompts for a cold start
- Structured data underneath, so answers are checkable

_[screenshot: **Zenith assistant** — a plain-language front door to meter data, with suggested prompts to get started.]_

---

## Page 09 — Locations, Contacts & Organization

A portfolio is not a flat list of meters. Every meter belongs to a location, every location to a tenant, and the people responsible are recorded alongside — so a reading always answers **where** and **whose**, not just how much.

### How the records nest

> _Diagram: A tenant contains locations, each location contains meters, and each meter contains registers; contacts attach at the tenant level._

### Location record

| Spec | Value |
|------|-------|
| Type | Warehouse · Apartment · Office |
| &nbsp; | Retail · Hotel · Building · Other |
| Address | street, unit, city, state, zip, country |
| State | active / inactive |
| Attached | meters, notes, audit stamps |

### Contact record

| Spec | Value |
|------|-------|
| Role | Customer · Client · Vendor |
| &nbsp; | Contractor · Technician · Sales Manager |
| Reach | email, phone, company |
| Address | full postal address |
| State | active / inactive |

### Organization settings — applied across the tenant

| Spec | Value |
|------|-------|
| Timezone | IANA zone |
| Currency | per tenant |
| Language | per tenant |
| Date format | e.g. MM/DD/YYYY |
| Time format | 12-hour / 24-hour |
| Default page size | rows per list |
| Reading batch count | capture batching |
| Identity | company name, contact email, website |

### A portfolio, as the platform sees it

| Location | Type | Meters | Registers | State |
|---|---|---|---|---|
| **Riverside Distribution** | Warehouse | 4 | 48 | active |
| **Harbour Point Apartments** | Apartment | 12 | 36 | active |
| **Fifth Street Retail** | Retail | 3 | 24 | active |
| **Old Mill Office** | Office | 2 | 12 | inactive |

_Example figures, shown to illustrate the shape of the records. Deactivating a location keeps its history rather than deleting it._

Timezone and formats are set once per tenant and applied everywhere — reading timestamps, report windows, alert history and exports — so a site in one zone and an accountant in another read the same figures without converting them by hand.

---

## Page 10 — Security & Administration

Access is decided in two independent layers: a **role** decides what a person can do, and the **tenant** decides which records exist for them at all. The second layer is enforced in the database, not only in the application.

### Roles

`superadmin` · `supersupport` · `adminsupport` · `admin` · `manager` · `technician` · `viewer` · `user`

### What each role may do

| Resource | Admin | Manager | Technician | Viewer |
|---|---|---|---|---|
| **Dashboard** | read | read | read | read |
| **Meters & registers** | create read update delete | create read update delete | create read update delete | read |
| **Notification rules** | create read update delete | create read update delete | create read update delete | read |
| **Reports** | create read update delete | create read update delete | create read update delete | read |
| **Locations** | create read update delete | create read update delete | read | read |
| **Contacts** | create read update delete | create read update delete | read | read |
| **Email templates** | create read update delete | create read update delete | read | read |
| **Users** | create read update delete | create read update | read | read |
| **Settings** | read update | read update | read | read |
| **Devices** | read | read | read | read |

_Rows are ordered by how much the roles diverge. **superadmin** carries every permission, the same set as **admin**. Each cell is a set of named permissions — report:create, meter:delete — so a role can be widened or narrowed without a code change._

### Isolation & transport

- Every record carries its tenant; queries are scoped to it
- Row-level security enforced in PostgreSQL itself
- HTTPS / TLS on every connection
- Rate limiting on authentication endpoints

### Audit & support

- Authentication events logged with status
- IP address and user agent recorded per event
- Created and updated stamps on every record
- In-platform support tickets, admin-triaged

### What an authentication event records

| Spec | Value |
|------|-------|
| User | account the event belongs to |
| Event type | what was attempted |
| Status | outcome of the attempt |
| IP address | origin of the request |
| User agent | client that made it |
| Timestamp | when it happened |

Because tenant isolation lives in the database, a bug in application code cannot leak one customer's meters to another. Role checks then run on top of that, on both the interface and the API — a hidden button is never the only thing standing between a user and a record.

---

## Page 11 — On-Site Sync Server

A compact, sealed, **Linux-based** appliance installed on site. It talks to meters over **BACnet and IP** and — the part that matters — **keeps metering when the internet goes down**, then catches the cloud up automatically once the link returns.

### Resilient by design — no data gaps

- **Meter & stream live** — Polls every meter on the local network at 15-minute intervals and streams readings to the cloud in real time.
- **Keeps metering offline** — If the site loses its link the appliance keeps polling and buffers every reading to local storage. Nothing is lost.
- **Auto-uploads & back-fills** — Buffered readings upload automatically and back-fill the timeline in order — no gaps, no manual steps.

### Appliance specifications

| Spec | Value |
|------|-------|
| Processor | Intel Core i5-8400T |
| Cores / clock | 6C · 3.3 GHz · 35 W |
| Memory | 16 GB DDR4 |
| Storage | 512 GB SSD |
| Operating system | Linux-based, hardened |
| Networking | Gigabit Ethernet (RJ-45) |
| Ports | USB 3.1 · USB-C · 2× DP · HDMI |
| Form factor | Micro, ≈1.2 L |
| Dimensions | 36 × 182 × 178 mm |
| Power | 65 W external adapter |
| Meter protocols | BACnet · IP |
| Local buffering | full readings retained offline |
| Recovery | fast reimage & redeploy |
| Uptime | 24/7 unattended |

### Enclosure specifications

| Spec | Value |
|------|-------|
| Model | Altelix 14×11×5 PC+ABS vented |
| Exterior | 13.4 × 11.6 × 6.3 in |
| Interior | 12.0 × 8.0 × 4.0 in |
| Material | Polycarbonate + ABS, UV-resistant |
| Flame rating | meets UL94-V0 |
| Environmental | NEMA 3R / 3RX · IP24 |
| Door | gasketed hinge, dual latch, key/padlock |
| Ventilation | 2× 3" vents, rain shields, screens |
| Mounting | wall; optional pole kit to 8" dia. |
| Weight | 3.2 lb (1.4 kg) |
| RF | transparent for on-site wireless |
| Included | grommets, ties, ground plate & wire |

_[screenshot: 07-syncserver-front]_

_[screenshot: 08-syncserver-rear]_

_[screenshot: 09-enclosure]_

---

## Page 12 — Specifications

Supported hardware and platform characteristics, current at this revision. Additional device models are added on request — the register model is generic, so a new meter is a configuration change rather than a release.

### Device compatibility

| Manufacturer | Description | Model no. | Type | Elements |
|---|---|---|---|---|
| **DENT Instruments** | PowerScout 48HD | PowerScout48HD | Electric | 48 |
| **TBWC, Inc.** | PS24 | DI-MMU8 | Electric | 24 |
| **TBWC, Inc.** | PS48 | DI-MMU16 | Electric | 16 |
| **TBWC, Inc.** | PS12 | DI-MMU4 | Electric | 12 |
| **TBWC, Inc.** | PS3 | DI-SAKIT | Electric | 3 |

### Platform

| Spec | Value |
|------|-------|
| Deployment | fully cloud-hosted (SaaS) |
| On-premises servers | none required |
| Access | any modern browser |
| Tenancy | multi-tenant, row-level isolated |
| Access control | role-based, 8 roles |
| Transport security | HTTPS / TLS |
| Meter focus | electricity |
| Meter models | physical & virtual |
| Reading interval | 15 min typical |
| Export formats | PDF · CSV · HTML · email |
| Site sync | edge sync-server appliance |
| Meter protocols | BACnet · IP |
| Scheduling | cron, server-side |
| Integrations | AI querying · CSV · REST API |

### Capability summary

- Physical & virtual electricity meters
- Per-register readings, graphs & alerts
- Custom dashboards & analytics
- Scheduled cost & revenue reports
- Multi-site portfolio management
- Threshold, no-reading & zero-reading alerts
- PDF / CSV export & scheduled email
- Zenith AI plain-language querying
- On-site sync server with offline resilience
- Row-level tenant isolation & auth audit log

### Revision history

| Rev | Pages | Changes |
|---|---|---|
| **A** | 9 | First issue. Overview, capabilities, meters & registers, captured data, dashboards, alerts, Zenith AI, sync server, specifications. |
| **B** | 12 | Added Scheduled Reports, Locations & Organization, and Security & Administration. Reset to A4 page geometry, restyled to a technical datasheet, refreshed portfolio-home screenshot. |

_Enclosure specification source: enclosurehub.com — Altelix 14×11×5 PC+ABS Weatherproof Vented Utility Box. Specifications are subject to change without notice._
