# MeterIt Pro — Application Sheet

**Electricity Meter Management** · Application Sheet
Document: MIP-AS-001 · Rev B · © 2026 MeterIt Pro
www.meteritpro.com | info@meteritpro.com

> This file is the editable source for the MeterIt Pro Application Sheet
> (the print/PDF version lives in `MeterItPro-Application-Sheet.html`).
> Screenshots referenced below are embedded in the HTML; they are noted here
> as `_[screenshot: …]_` placeholders so this document stays easy to edit.

---

## Page 1 — Overview

### MeterIt Pro — Cloud Electricity Meter Management

MeterIt Pro is a cloud-based electricity meter data management platform for meter
manufacturers, resellers, utilities and facility teams. Automate readings, validate
data, generate reports and query your portfolio with AI — across a single site or
hundreds of locations, from any browser.

**Core coverage**

- Electricity Metering
- kWh · kVA · Amps
- Per-Phase Detail
- 15-min Intervals

**At a glance**

| Metric | Meaning |
|--------|---------|
| **24/7** | Real-time access to all meter data |
| **100%** | Cloud-hosted — no on-prem setup |
| **100s** | Locations from one dashboard |
| **RBAC** | Role-based access per tenant |

_[screenshot: Portfolio home dashboard — energy, peak demand, active meters and open alerts at a glance, with live recent activity and favorite registers. — meteritpro.com/home]_

---

## Page 2 — Core Capabilities

Purpose-built electricity metering software that keeps every reading accurate,
traceable and easy to analyze — one platform for capture, validation, analytics,
alerting and reporting.

- **Smart Meter Capture** — Mobile-friendly workflows guide technicians through every reading. Physical and virtual electricity meters, captured at the register and circuit level.
- **Validation & Anomaly Detection** — Automatic quality checks flag anomalies and missing data before reports go out, so your data stays audit-ready.
- **Energy Analytics & Reporting** — Track usage trends, peak demand and cost efficiency across all meters. Export to PDF or CSV for billing, audits and analysis.
- **Multi-Site Portfolio** — Manage readings across hundreds of locations from a single dashboard — ideal for ESCOs, property managers and facility teams.
- **Alerts & Notifications** — Set threshold-based rules on any register and get notified instantly when readings fall outside expected ranges.
- **AI-Ready Data Platform** — Query your meter data in plain language with the built-in Zenith assistant. Built for AI integration from day one.

### Full Visibility, Access Anywhere

- Live dashboard updates — no manual refresh or exports
- Desktop, tablet or mobile on any modern browser
- Role-based access — field, manager and client views
- Secure, encrypted connections (HTTPS/TLS)
- Tenant-level data isolation across every account
- Share read-only portfolio views with stakeholders

---

## Page 3 — Meters & Registers

Every meter is modelled with its own registers (elements) — Mains, A/C, Receptacles
and more — so consumption is tracked at the circuit level, not just the building level.

**Setup steps**

1. Name the meter & assign its location
2. Choose physical or virtual meter
3. Assign device model & sync server
4. Map registers / elements
5. Set alert rules on any register
6. Assign role-based user access

### Meter Types

- **Physical meters** — Bound to a device on a sync server; MeterIt Pro polls it for live readings.
- **Virtual meters** — Derived from other meters (e.g. "mains less lighting") — no hardware required.

### Per-Meter Registers

- Multiple registers / elements per meter
- Named channels
- Per-register readings, graphs & alerts
- Serial, IP, sync server & live status

_[screenshot: Meter list — physical and virtual meters, each tied to a device, IP address, sync server and live status. — meteritpro.com/meters]_

---

## Page 4 — Metering Data Captured

Per register, per interval — the full electrical picture, retained and queryable.
Readings are timestamped and export-ready as CSV or PDF, or emailed on a schedule.

| Parameter | Unit | Resolution | Notes |
|-----------|------|------------|-------|
| **Energy** | kWh | 15-min interval | Cumulative & calculated consumption |
| **Apparent power** | kVA | 15-min interval | Total load |
| **Apparent power, per phase** | kVA | 15-min interval | Phase A / B / C |
| **Current** | A | 15-min interval | Total current draw |
| **Current, per phase** | A | 15-min interval | Phase A / B / C |
| **Timestamp** | ISO | Per reading | Local site time, audit-retained |

_[screenshot: Detailed register readings — kWh, calculated kWh, kVA, per-phase kVA and per-phase amperage at 15-minute intervals, with one-click Export & Email. — meteritpro.com/meter-readings]_

---

## Page 5 — Dashboards & Analytics

Compose custom dashboards from configurable chart widgets. Set the time range, chart
type, granularity and aggregation on each widget — then refresh, export or email it.

- Multiple dashboards per user
- Drag-and-drop widget layout
- Range: since install, daily or custom
- Granularity down to 15-minute intervals
- Aggregation: max, min, average, sum
- Per-widget refresh, export & email

**Chart types:** Bar · Line · Area · Pie / Ring · Tabular

_[screenshot: Custom dashboard — a Peak kW widget with configurable range, chart type, granularity and aggregation. Build the exact view each team needs. — meteritpro.com/dashboard]_

---

## Page 6 — Alerts & Notifications

Define alert rules once and let the platform watch every register around the clock.
Catch a stalled meter or a runaway load before your clients do.

### Rule Types

- **Custom** — threshold rules on any parameter
- **No Reading** — when a meter goes silent
- **Zero Reading** — for dead or stalled channels
- Active / inactive per rule, with full history

### Notification Channels

- In-app banner on the platform
- Email alerts with a link to the meter in alarm
- Threshold breach, over-interval & over-time
- Scheduled scans clear stale notifications

_[screenshot: Notification rules — custom, no-reading and zero-reading rule types, each toggled active or inactive per register. — meteritpro.com/notification-rules]_

---

## Page 7 — Zenith AI Assistant

Query meters, readings and alerts in plain language — no reports to build, no filters
to configure. Zenith reads across your whole portfolio and answers in seconds.

**Ask questions like**

- "Which meters haven't reported in 48 hours?"
- "What is my total consumption today?"
- "Which alert rules triggered this week?"
- "Summarize peak demand across all sites."

_[screenshot: Zenith assistant — a plain-language front door to your meter data, with suggested prompts to get started. Built for AI integration from day one. — meteritpro.com/ai-chat]_

---

## Page 8 — On-Site Sync Server

The MeterIt Pro Sync Server is a compact, sealed, **Linux-based** appliance installed
on-site. It talks directly to your meters over **BACnet and IP** and, critically,
**keeps metering even when the internet goes down** — then catches the cloud up
automatically once the connection returns. The hardened Linux image is fast to
redeploy and built for optimal, unattended uptime.

### Resilient by Design — No Data Gaps

1. **Online · Normal — Meter & stream live** — Polls every meter on the local network at 15-minute intervals and streams readings to the MeterIt Pro cloud in real time.
2. **Internet Outage — Keeps metering offline** — If the site loses internet, the Sync Server keeps polling and buffers every reading to local storage. Nothing is lost.
3. **Reconnected — Auto-uploads & back-fills** — When the connection returns, buffered readings upload automatically to the production site and back-fill the timeline — no gaps, no manual steps.

### Hardware

- **Sync Server** — Dell Micro Desktop
- **Enclosure** — Altelix 14×11×5 vented NEMA weatherproof box (see specs below)

### Sync Server Specifications

| Spec | Value |
|------|-------|
| Processor | Intel Core i5-8400T |
| Cores / clock | 6C · up to 3.3 GHz · 35 W |
| Memory | 16 GB DDR4 |
| Storage | 512 GB SSD |
| Operating system | Linux-based (hardened) |
| Graphics | Intel UHD 630 |
| Networking | Gigabit Ethernet (RJ-45) |
| Ports | USB 3.1 · USB-C · 2× DP · HDMI |
| Form factor | Micro (≈1.2 L chassis) |
| Dimensions | 36 × 182 × 178 mm |
| Power | 65 W external adapter |
| Meter protocols | BACnet · IP |
| Local buffering | Full readings retained offline |
| Recovery | Fast reimage & redeploy |
| Uptime | 24/7 unattended operation |

### Enclosure — Altelix 14×11×5 Vented NEMA Weatherproof Box

Sealed, weatherproof, vented wall/pole-mount enclosure housing the Sync Server.
Polycarbonate + ABS construction with a gasketed hinged door and dual latches;
RF-transparent for on-site wireless, and ventilated for continuous 24/7 operation.

- Weatherproof, UV-stable PC + ABS enclosure — NEMA 3R / 3RX / IP24
- Gasketed hinged door with dual latches + tamper-proof locking screw (key & padlock provision)
- Two 3" vents with rain shields and cleanable screens for airflow
- RF-transparent for on-site wireless devices

#### Enclosure Specifications

| Spec | Value |
|------|-------|
| Model | Altelix 14×11×5 PC+ABS Weatherproof Vented Utility Box |
| Exterior dimensions | 13.4 × 11.6 × 6.3 in (340 × 294 × 161 mm) |
| Interior dimensions | 12.0 × 8.0 × 4.0 in (305 × 203 × 102 mm) |
| Material | Polycarbonate + ABS (UV-resistant, industrial grade) |
| Flame rating | Meets UL94-V0 |
| Environmental rating | NEMA Type 3R, 3RX / IP24 |
| Door / security | Gasketed hinged door, dual latches, tamper-proof locking screw (key & padlock) |
| Ventilation | Two (2) 3" vents with rain shields and cleanable screens |
| Mounting | Wall mount hardware included; optional pole-mount kits (poles up to 8" dia.) |
| Knockouts | 4× 0.62" (16 mm), 4× 0.78" (20 mm), 4× 1.30" (33 mm, top & bottom) |
| Weight | 3.2 lbs (1.4 kg) |
| Colors | Gray, Black, Light Ivory, OD Green |
| Included accessories | Cable grommets, zip ties, cable-management loops, ground plate, ground wire |
| RF | RF-transparent for wireless devices |

_Source: [enclosurehub.com — Altelix 14x11x5 PC+ABS Weatherproof Vented Utility Box](https://enclosurehub.com/products/altelix-14x11x5-pc-abs-weatherproof-vented-utlity-box-nema-enclosure-with-hinged-door)_

---

## Page 9 — Specifications

### Device Compatibility

| Manufacturer | Description | Model no. | Type | Elements |
|--------------|-------------|-----------|------|----------|
| **DENT Instruments** | PowerScout 48HD | PowerScout48HD | Electric | 48 |
| **TBWC, Inc.** | PS24 | DI-MMU8 | Electric | 24 |
| **TBWC, Inc.** | PS48 | DI-MMU16 | Electric | 16 |
| **TBWC, Inc.** | PS12 | DI-MMU4 | Electric | 12 |
| **TBWC, Inc.** | PS3 | DI-SAKIT | Electric | 3 |

### Technical Specifications

| Spec | Value |
|------|-------|
| Deployment | Fully cloud-hosted (SaaS) |
| On-premises servers | None required |
| Access | Any modern browser |
| Tenancy | Multi-tenant, isolated |
| Access control | Role-based (RBAC) |
| Transport security | HTTPS / TLS |
| Meter focus | Electricity only |
| Meter models | Physical & virtual |
| Reading interval | 15 min (typical) |
| Export formats | PDF · CSV · Email |
| Site sync | Edge sync-server agents |
| Meter protocols | BACnet · IP |
| Integrations | AI querying · CSV · REST API |

### Platform Capabilities

- Physical & virtual electricity meters
- Per-register readings, graphs & alerts
- Custom dashboards & analytics
- Multi-site portfolio management
- Threshold, no-reading & zero-reading alerts
- PDF / CSV export & scheduled email
- Zenith AI plain-language querying
- On-site Sync Server with offline resilience
