# MiniHotel API Reference

> Internal reference for the **Rental Orchestrator Hub**. Captures the full MiniHotel
> PMS / Channel-Manager API surface so we can borrow the right ideas — and design real
> integrations — when building new capabilities. MiniHotel is a candidate **PMS + channel
> backbone**: it can pull/push Availability-Rates-Inventory (ARI), inject and modify
> reservations, post room charges, fire real-time room-occupancy webhooks, and expose a
> hosted Booking Engine. Those map cleanly onto the Hub's four departments (see the
> integration map below).
>
> **Last updated:** 2026-06-07
> **Upstream source:** `https://minihotel.readme.io/reference` (+ the public
> "ARI (XML) Web Service Interface" doc on `minihotelpms.com`).

---

## How this was built (and its limits)

- **Sourcing method:** consolidated from a multi-session scrape of the MiniHotel readme.io
  reference, cross-checked against MiniHotel's public developer pages via web search.
- **403 wall:** like the PriceLabs help center, the entire MiniHotel docs estate
  (`minihotel.readme.io`, `minihotelpms.com`, `minihotel.io`) returns **HTTP 403** to
  automated fetchers, and this environment's host allowlist blocks direct `curl`. So pages
  **could not be re-scraped verbatim** at write time — content is reconstructed from the
  captured material plus search corroboration.
- **One correction applied:** an earlier draft of the ARI section described
  `…/ari/ariMain.asmx/GetBulkARI`-style SOAP/ASMX endpoints, a `<User>`-based auth block,
  and a numeric `0/1/2/99` error table. **None of that is real** — a web search returns no
  hits for those endpoints, and MiniHotel's published ARI interface is the **XML `/gds`**
  service documented in §2. The hallucinated variant has been removed. If you find evidence
  of an ASMX ARI service, treat it as new information and reconcile here.
- **Confidence tags:**
  - **§2 ARI API** — *high*. XML `/gds` interface confirmed against MiniHotel's public
    "ARI (XML) Web Service Interface" doc; examples are verbatim from the reference.
  - **§3 Content/Data/POS API** — *function inventory: high* (names match MiniHotel's own
    "Core API Functionality" list); *exact endpoint URLs: unverified* — confirm each
    `.asmx` path against the live reference before coding against it.
  - **§4 Reverse ARI**, **§5 Payments**, **§6 Booking Engine**, **§7 Webhooks** — *high*.
    Captured with full request/response examples and internally consistent.
- **Truncation:** a few §3 functions and the §5 response table were cut off mid-capture and
  are flagged **(partial — re-scrape)** inline.

## How to use this reference

1. **Learning:** §1–§7 are the API inventory, grouped by API family, each with endpoints,
   parameters, and request/response examples.
2. **Building:** start from the **Integration map** to see which API a feature needs, then
   jump to that section. Anything tagged *(unverified)* or *(partial)* must be confirmed
   against the live docs (or with MiniHotel support) before you ship against it.
3. **Keep it alive:** this is a point-in-time capture. Re-run the sweep when MiniHotel ships
   changes (e.g., the Generic Payment Gateways API went live 2025-09-01) and bump
   *Last updated*.

---

## TL;DR — the three API families

| Family | Direction | Format | Transport | Who it's for |
| :----- | :-------- | :----- | :-------- | :----------- |
| **ARI API** (§2) | Pull ARI from MiniHotel **+** push reservations in | XML | POST to `/gds` | OTAs, tour operators, B2B marketplaces, channel managers, RMS |
| **Content, Data & POS API** (§3) | Read/update static + dynamic hotel data | XML (some JSON) | POST | POS / restaurant / kiosk, self-check-in, guest apps |
| **Reverse ARI API** (§4) | Push ARI **into** MiniHotel | JSON **or** XML | POST | RMS, PMS platforms, B2B marketplaces, channel managers |

Plus three more surfaces: **Generic Payment Gateways API** (§5, for PSPs), the hosted
**Booking Engine** (§6, direct link or iframe embed), and **Webhooks** (§7, real-time
room-occupancy push).

---

## Integration map — MiniHotel ↔ Rental Orchestrator Hub

How each MiniHotel capability could feed a department/worker from `spec.md`. (Real
integrations are a non-goal for the current milestone — this is forward-looking prior art.)

| Hub department / worker | MiniHotel capability | API |
| :---------------------- | :------------------- | :-- |
| **Revenue & Yield** → Pricing Specialist | Push rates / availability / min-nights / closures | Reverse ARI (§4) |
| **Revenue & Yield** → Pricing Specialist | Pull current ARI to reconcile / detect drift | Bulk ARI (§2.2), Immediate ARI (§2.3) |
| **Revenue & Yield** → Listing Optimizer | Hosted booking funnel (direct-channel presence) | Booking Engine (§6) |
| **Operational Logistics & QC** → Field QC Agent | Real-time occupied/vacant signal (smart locks, IoT, QC timing) | Webhooks `room.occupancy.updated` (§7); Room Status Inquiry (§2.4) |
| **Operational Logistics & QC** → Supply Manager | Read room/cleaning status; flip clean state | `getRooms()` (§3.2), `UpdateCleanStatus()` (§3.3) |
| **Operational Logistics & QC** | Post consumable/upsell charges to the folio | `SendRoomCharges()` (§3.2) |
| **Guest Relations & Concierge** → Inquiry Specialist | Inject / modify / cancel bookings | Create & Modify Reservations (§2.5) |
| **Guest Relations & Concierge** → Digital Concierge | Transactional email / SMS to guests | `sendEmail()`, `sendSMS()` (§3.2) |
| **Guest Relations & Concierge** | Folio balance, check-in docs (passport/ID upload) | `GetReservationBalance()`, `saveDocuments()`, `getDocuments()` (§3.2) |
| **Cross-cutting** → payments | Card capture / pre-auth / guarantee | `sendPayment()`, `processCreditCard()` (§3.2); Generic Payment Gateways (§5) |

---

## 0. Conventions

**Sandbox credentials** (shared across the docs):

```text
username = "Test"
password = "3657488"
hotel id = "sandbox"
```

**Environments** (base URLs differ per API family):

| API family | Sandbox | Production |
| :--------- | :------ | :--------- |
| ARI API (§2) | `https://sandbox.minihotel.cloud/gds` | `https://api.minihotel.cloud/gds` |
| Content/Data/POS (§3) | `https://sandbox.minihotel.cloud/agents/ws/` *(unverified)* | `https://api.minihotel.cloud/agents/ws/` *(unverified)* |
| Reverse ARI (§4) | `https://sandbox.minihotel.cloud` | `https://api2.minihotel.cloud` |
| Booking Engine (§6) | `https://sandbox.minihotel.cloud/BookingFrameClient/…` | `https://frame1.hotelpms.io/BookingFrameClient/…` |

**Production checklist:** test on sandbox → MiniHotel issues production credentials + real
hotel IDs → **whitelist your server IPs** with MiniHotel before go-live. The PMS GUI at
`https://login.minihotel.cloud` is for visually verifying API actions (GUI credentials are
**not** API credentials).

---

## 1. Get Started

**About MiniHotel.** All-in-one cloud Hotel Management Software + Channel Manager, aimed at
small-to-medium hotels, boutique hotels, vacation rentals, and all accommodation types.
Thousands of clients across ~65 countries.

**Core API functionality (the authoritative function inventory).**

*Content & Data API — XML functions:*
- **Reservation Management:** `GetReservationKey()`, `UpdateReservation()`,
  `ChangeReservationStatus()`, `ChangeReservationCountry()`, `GetReservationBalance()`
- **Operations & Logistics:** `getRooms()`, `getRoomTypes()`, `sendRoomCharges()`,
  `saveDocuments()`, `getDocuments()`, `GetDayUseReservationsMap()`
- **Communication & Payments:** `sendPayment()`, `processCreditCard()`, `sendEmail()`,
  `sendSMS()`

*Content & Data API — JSON functions:*
- **Operations:** `UpdateCleanStatus()`
- **POS Management:** `GetPosItems()`, `UpdatePosItem()`

> This list is MiniHotel's own and is treated as ground truth for which Content/Data/POS
> functions exist (§3). Detailed specs below are filled in where the scrape captured them.

---

## 2. ARI API

> **XML over POST**, to the `/gds` endpoint. For OTAs, Tour Operators, RMS, and Channel
> Managers — sync ARI both directions and inject reservations.

### 2.1 Preface & Authentication

- **Sandbox:** `https://sandbox.minihotel.cloud/gds`
- **Production:** `https://api.minihotel.cloud/gds`
- **Auth** is carried in the request XML's `Authentication` element:
  `username`, `password`, and (per operation) a `ResponseType` selector.

**XML decode helper (C#).** Responses XML-escape their payloads; un-escape before parsing:

```csharp
public string UnEscapeXml(string input)
{
    string output = string.Empty;
    output = input.Replace("&amp;",  "&");
    output = output.Replace("&apos;", "'");
    output = output.Replace("&quot;", "\"");
    output = output.Replace("&gt;",   ">");
    output = output.Replace("&lt;",   "<");
    return output;
}
```

### 2.2 Bulk ARI Data

Pulls Availability, Rates, and Restrictions for a period (**max 2 years**). Intended for
OTAs/agencies that maintain their own ARI database.

**Request parameters:**

| Element | Attributes | Description |
| :------ | :--------- | :---------- |
| `Authentication` | `username`, `password` | API credentials |
| `Authentication` | `MinimumNights` | `"YES"` or `"NO"` (default). Returns MinNights if `YES`. |
| `Hotel` | `id` | Hotel ID (e.g. `"sandbox"`) |
| `DateRange` | `from`, `to` | Start / end dates |
| `Guests` | `adults`, `child`, `babies` | Guest configuration |
| `Prices` | `rateCode` | **Mandatory.** One rate code per call. |

**Request:**

```xml
<root version="1.0" encoding="UTF-8" ?>
<Authentication username="Test" password="3657488" ResponseType="05" />
<Hotel id="sandbox" />
<DateRange from="2022-06-20" to="2022-06-30" />
<Prices rateCode="USD" />
```

**Response (snippet):**

```xml
<Room id="DBL" RoomName="Double Room" BasicOccupancy="002">
    <Date Mdate="20220115" Mavailability="4" Mprice="26.10" Minngt="0"
          Mclose="No" McloseArr="No" McloseDep="No"
          ExtraAdultFee="22.00" ExtraChildFee="10.00" ExtraBabyFee="7.00"
          SingleUse="0.00" />
</Room>
```

### 2.3 Immediate ARI Data

For partners who do **not** store data locally and need real-time responses for a specific
stay period and a single rate code. **Price values are for the full stay, not per night.**

**Request parameters:**

| Element | Attributes | Description |
| :------ | :--------- | :---------- |
| `Authentication` | `username`, `password` | API credentials |
| `Authentication` | `MinimumNights` | Optional: `YES`/`NO` (default `NO`) |
| `Hotel` | `id` | Specific Hotel ID |
| `Area` | `id` | Alternative to Hotel ID |
| `DateRange` | `from`, `to` | Stay period |
| `Guests` | `adults`, `child`, `babies` | Guest count |
| `Agent` | `id` | Partner / agent filter |
| `RoomTypes → RoomType` | `id` | Optional. Default `*ALL*`. `*MIN*` = lowest rate. |
| `Prices` | `rateCode` | **Mandatory.** Rate code (e.g. `"USD"`) |
| `Prices → Price` | `boardCode` | **Mandatory.** `*ALL*` or `*MIN*` |

**Request:**

```xml
<?xml version="1.0" encoding="UTF-8" ?>
<Request>
  <Authentication username="Test" password="3657488" />
  <Hotel id="sandbox" />
  <DateRange from="2024-06-18" to="2024-06-21" />
  <Guests adults="2" child="" babies="" />
  <RoomTypes><RoomType id="*ALL*" /></RoomTypes>
  <Prices rateCode="USD"><Price boardCode="*ALL*" /></Prices>
</Request>
```

**Response (snippet):**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hotel id="sandbox" Name_h="Test Hotel MiniHotel" Name_e="Test Hotel MiniHotel" Currency="USD" />
  <DateRange from="2024-06-18" to="2024-06-21" />
  <RoomType id="2BEDAPT" Name_h="Two bedroom apartment" Name_e="Two bedroom apartment">
    <Inventory Allocation="5" maxavail="5" />
    <Price board="BB" boardDesc="BB" value="352.50" value_nrf="317.25" />
  </RoomType>
</Response>
```

> `value_nrf` = non-refundable rate value.

### 2.4 Real-Time Room Status Inquiry

Detailed room, room-type, and reservation info within a date range — for occupancy
monitoring (in-room security, mini-bar, etc.). Uses `ResponseType="03"` +
`GetDailyStayInquiry`.

**Request:**

```xml
<?xml version="1.0" encoding="UTF-8" ?>
<Request xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <Authentication username="Test" password="3657488" ResponseType="03" />
    <Hotel id="sandbox" />
    <DateRange from="2024-07-14" to="2024-07-17" />
    <GetDailyStayInquiry />
</Request>
```

**Response elements:**
- `Rooms` — all rooms at query time, regardless of occupancy.
- `RoomsTypes` — all room types at query time.
- `Reservations` — only reservations within the queried date range.

**Reservation status codes:**

| Code | Meaning |
| :--- | :------ |
| `OK` | Confirmed |
| `WL` | Pending (waitlist) |
| `IN` | Checked-in |
| `OUT` | Checked-out |
| `CL` | Cancelled |
| `BL` | Black list |

> For event-driven occupancy (vs. polling this endpoint), prefer the
> `room.occupancy.updated` webhook (§7).

### 2.5 Create & Modify Reservations

Inject reservations into MiniHotel via XML. Supports single-room and multi-room (group)
bookings.

**Create:**

```xml
<Booking id="123456789" type="Book" createDateTime="23/12/2019" source="Web" rateCode="Standard" Board="HB">
  <RoomStay roomTypeID="TRP" roomTypeName="Triple Room" Board="HB">
    <StayDate arrival="2020-01-21" departure="2020-01-23"/>
    <Occupancy adult="2" child="1" baby="0"/>
    <Total AmountAfterTaxes="900" CurrencyCode="USD"/>
    <Name givenName="Jon" surname="Doe"/>
  </RoomStay>
</Booking>
```

- **Modify:** set `type="Modify"`.
- **Cancel:** set `type="Cancel"`.

**Key elements:**
- `Booking id` — unique ID. If unavailable, use `KioskPos` (coordinate with MiniHotel first).
- `source` — identifies the portal / agent.
- `rateCode` — determines rate **and** currency.
- `Vat` — optional: `Yes` or `Not`.
- `RoomStay` — use `roomTypeID` for auto-allocation, or `roomNumber` for a specific room.
- `Arrtime` / `Deptime` — **mandatory for day-use reservations.**

**Success response:**

```xml
<BookingConfirmNumbers>
  <BookingConfirm bookingID="324234342" resnumber="007012539"/>
</BookingConfirmNumbers>
```

### 2.6 ARI PUSH

MiniHotel **pushes** ARI data to a provider-hosted listener at pre-configured intervals
(typically every **5–10 minutes**). XML over POST.

- **Endpoint (yours):** `https://providerdomain.com/?hotelid=XXX`

**Availability:**

```xml
<room id="Double" date="2014-03-26" Allocation="3" maxavail="4" />
```

**Rates:**

```xml
<room id="Double" date="2013-07-30">
    <rate ratecode="Standard" Price="350" />
    <rate ratecode="EXTRA_A" Price="50" />
    <rate ratecode="CLS_NONE" Price="1" />
</room>
```

**Restriction types (binary, carried as pseudo rate codes):**

| Code | Meaning |
| :--- | :------ |
| `CLS_NONE` | Close for stayover |
| `CLS_ARR` | Close for arrival |
| `CLS_DEP` | Close for departure |
| `MIN_NGT` | Minimum nights stayover |
| `MIN_NGT1` | Minimum nights arrival |

### 2.7 Error Codes

| Code | Description |
| :--- | :---------- |
| `ERR 001` | Invalid XML |
| `ERR 003` | Missing dates parameter |
| `ERR 004` | Missing From date parameter |
| `ERR 005` | Missing To date parameter |
| `ERR 006` | Missing guests parameter |
| `ERR 009` | Missing hotel id |
| `ERR 010` | Wrong hotel id = no connection |
| `ERR 011` | Failed to parse `UpdateBookingInfoRQ` |
| `ERR 101` | Wrong Arrival date |
| `ERR 102` | Wrong Departure date |
| `ERR 103` | Wrong Dates Range |
| `ERR 104` | Minimal Nights Exception |
| `ERR 105` | Closed To arrival |
| `ERR 106` | Arrival date < today |
| `ERR 107` | More than 20 Nights |
| `ERR 108` | Less than 1 Night |
| `ERR 109` | Agent not linked to requested hotel |
| `ERR 204` | Hotel Code and area code are missing |
| `ERR 205` | No hotels found in area code |
| `ERR 209` | Too many requests sent to interface |
| `ERR 501` | Invalid Request |
| `ERR 516` | Invalid XML — No Reservation created |

---

## 3. Content, Data & POS API

> Reservation management, document handling, payments, messaging, and room operations.
> Mostly **XML over POST**, plus a few JSON functions. Targets POS/restaurant/kiosk systems,
> self-check-in, and guest apps.
>
> ⚠️ **Endpoint URLs in this section are *unverified*** (readme.io is 403 to fetchers). The
> **function names** are confirmed against MiniHotel's own inventory (§1); the **request
> examples** are as captured. Confirm each `.asmx` path against the live reference before
> coding.

### 3.1 Authentication

All XML requests carry an auth block + hotel:

```xml
<Authentication username="Test" password="3657488" />
<Hotel id="sandbox" />
```

Base sandbox URL: `https://sandbox.minihotel.cloud/agents/ws/` *(unverified)*

### 3.2 XML functions

#### `GetReservationKey()`
Retrieve an internal reservation key by external reservation ID.
Endpoint *(unverified)*: `…/sci/sciMain.asmx/GetReservationKey`

| Request | Type | | Response | Type |
| :------ | :--- |:-| :------- | :--- |
| `ResNumber` — external reservation number | String | | `InternalKey` — internal MiniHotel key | String |

#### `UpdateReservation()`
Update reservation details. Endpoint *(unverified)*: `…/sci/sciMain.asmx/UpdateReservation`

| Parameter | Description | Type |
| :-------- | :---------- | :--- |
| `ReservationNumber` | 9-character reservation number | String |
| `FirstName` | Guest first name | String |
| `LastName` | Guest last name | String |
| `Email` | Guest email | String |
| `Phone` | Guest phone | String |
| `Notes` | Free-text notes | String |

#### `getRooms()`
Room information & static data per room number (codes, attributes, occupancy settings,
cleaning status, …). Leave `room_number` empty to return **all** rooms.
Endpoint *(unverified)*: `…/settings/rooms/RoomsMain.asmx/getRooms`

| Element | Description | Type |
| :------ | :---------- | :--- |
| `room_number` | Room number (optional; empty = all rooms) | String |

#### `SendRoomCharges()`
Post a charge/debit to a guest account. For POS, restaurant, and upsell partners.
Endpoint *(unverified)*: `…/pos/pos.asmx/SendRoomCharges`

| Parameter | Description | Type |
| :-------- | :---------- | :--- |
| `lang_code` | Language code | String |
| `RoomCharges` | Charges list container | List Of() |
| `#RoomCharge` | Charge object | Object() |
| `#ChargeDate` | Charge date (optional, default: today) | String |
| `#ChargeTime` | Charge time (optional, default: now) | Double |
| `#RoomNumber` | Room number | String |
| `#Amount` | Charge amount | Double |
| `#DepartmentCode` | Department code | String |
| `#Description` | Charge description | String |

#### `GetReservationBalance()`
Returns the reservation's accounting folio: debits, credits, payments, and remaining
balance. Endpoint *(unverified)*: `…/sci/sciMain.asmx/GetReservationBalance`

Request: `ReservationNumber` — MiniHotel reservation number (9 chars), String.

| Response field | Description | Type |
| :------------- | :---------- | :--- |
| `Balance` | Main element | XElement |
| `#ReservationNumber` | Reservation number | String |
| `#Transactions` | List of transactions | — |
| `#Transaction` | Transaction object | — |
| `#Account` | Account number | String |
| `#Date` | Date (`yyyyMMdd`) | String |
| `#Time` | Time (`hh:MM`) | String |
| `#Department` | Department | String |
| `#DebitCredit` | `1` = Dept charge, `2` = Payment | Integer |
| `#Details` | Transaction details | String |
| `#Amount` | Transaction amount | Double |
| `#Currency` | Local default currency code | String |
| `#Debit` | Reservation debit amount | Double |
| `#Credit` | Reservation credit amount | Double |
| `#TotalDebit` | Total debit amount | Double |

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Request>
  <Payment language="ENG">
    <Hotel id="sandbox" />
    <Authentication username="Test" password="3657488" />
    <ReservationNumber>070002969</ReservationNumber>
  </Payment>
</Request>
```

#### `saveDocuments()`
Save documents (images) into a reservation. **Max 4 docs, max 3 MB each.**
Endpoint *(unverified)*: `…/sci/sciMain.asmx/saveDocuments`

| Parameter | Description | Type |
| :-------- | :---------- | :--- |
| `Documents` | Documents node list | List Of() |
| `#Document` | Document container (max 4, max 3 MB each) | — |
| `@rs_number` | Reservation number | String |
| `@doc_type` | `JPG`, `JPEG`, `PNG`, or `PDF` | String |
| `@doc_value` | Base64-encoded file | String |
| `@description` | Document description | String |

```xml
<Request>
  <sci_saveDocuments>
    <Authentication username="Test" password="3657488" />
    <Hotel id="sandbox" />
    <Documents>
      <Document rs_number="007006512"
                Doc_type="jpg"
                Doc_value="BASE 64 STRING"
                Description="Guest passport" />
    </Documents>
  </sci_saveDocuments>
</Request>
```

#### `getDocuments()`
Fetch previously saved documents from a reservation.
Endpoint *(unverified)*: `…/sci/sciMain.asmx/getDocuments`

Request: `rs_number` — reservation number, String.
Response: `Documents` list of `Document` with `@src` (image URL), `@description`, `@id`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<root>
  <method name="sci_getDocuments">
    <authentication username="Test" password="3657488" />
    <agent id="sandbox" />
    <parameters>
      <rs_number>007000584</rs_number>
    </parameters>
  </method>
</root>
```

#### `sendPayment()` **(partial — re-scrape)**
Create a payment (with or without credit-card processing) and generate a receipt/invoice.
Use a `SimulatorCode` to test without actually charging.
Endpoint *(unverified)*: `…/sci/sciMain.asmx/sendPayment`
Captured params: `Amount` (Double, e.g. `100.00`), `Currency` (String), `Description`
(String) … *(remaining fields were truncated in capture).*

#### Functions named in MiniHotel's inventory but **not** captured in detail here
Re-scrape these from the live reference before use:

| Function | Purpose (from §1 inventory) |
| :------- | :-------------------------- |
| `processCreditCard()` | Process a credit-card transaction |
| `getRoomTypes()` | List room types / static data |
| `sendEmail()` | Send a transactional email to a guest |
| `sendSMS()` | Send an SMS to a guest |
| `ChangeReservationStatus()` | Change a reservation's status |
| `GetDayUseReservationsMap()` | Day-use reservation map |
| `ChangeReservationCountry()` | Change a reservation's country |

### 3.3 JSON functions **(named only — re-scrape for detail)**

| Function | Purpose |
| :------- | :------ |
| `UpdateCleanStatus()` | Update a room's cleaning status (housekeeping) |
| `GetPosItems()` | Fetch POS items |
| `UpdatePosItem()` | Create/update a POS item |

---

## 4. Reverse ARI API

> Push **ARI into** MiniHotel (availability, rates, restrictions) plus operational data like
> room cleaning status. **JSON or XML over POST.** Used by RMS, PMS platforms, B2B
> marketplaces, and channel managers — typically partners that hold their own per-property
> ARI database and sync MiniHotel's connected OTAs (Booking.com, Airbnb, Expedia, Despegar,
> Agoda, Hostelworld, …).

### 4.1 Preface & Authentication

Auth is via **request headers** (not the body):

```text
User      = "Test"
Password  = "3657488"
hotel_id  = "sandbox"
```

| | Base endpoint |
| :--- | :------------ |
| Sandbox | `https://sandbox.minihotel.cloud` |
| Production | `https://api2.minihotel.cloud` |

> Each module/function has its own suffix on the same base. Every response includes an
> **`X-Request-ID`** header (a GUID) — capture it; MiniHotel support needs it to trace issues.

### 4.2 Bulk ARI — Reverse API

- **Sandbox:** `https://sandbox.minihotel.cloud/AgentsScreenA/api/Agents/ScreenA`
- **Production:** `https://api2.minihotel.cloud/AgentsScreenA/api/Agents/ScreenA`
- **Method:** POST. **Max update window: 2 years.** (Query window noted as 1.5 years.)

**Models.**

*Room*

| Parameter | Description | Type | Req? |
| :-------- | :---------- | :--- | :--- |
| `RoomTypeCode` | Room type code to update | String | Required |
| `Dates` | Array of `Date` | Array[Date] | Required |

*Date* — **omit optional fields you don't want to change.**

| Parameter | Description | Type | Req? | Notes |
| :-------- | :---------- | :--- | :--- | :---- |
| `Date` | Date to update | String | Required | `YYYY-MM-DD`; min = today, max = +2 years |
| `Availability` | Rooms available for this type | Integer | Optional | 0–999; `null` clears the manual override |
| `MinimumNights` | Min nights a guest must book | Integer | Optional | |
| `MinimumNightsArrival` | Min nights if checking in this date | Integer | Optional | |
| `Close` | Closed (non-bookable) on this date | Boolean | Optional | |
| `CloseOnArrival` | Not bookable if checking **in** this date | Boolean | Optional | |
| `CloseOnDeparture` | Not bookable if checking **out** this date | Boolean | Optional | |
| `Rates` | Array of `Rate` (per price list) | Array[Rate] | Optional | |

*Rate*

| Parameter | Description | Type | Req? | Notes |
| :-------- | :---------- | :--- | :--- | :---- |
| `PriceList` | Price list code to update | String | Required | |
| `Price` | Rate for this price list | Decimal | Required | Decimal or `null`; `null` removes the current price |

**JSON — single date:**

```json
[
  {
    "RoomTypeCode": "DBL",
    "Dates": [
      {
        "Date": "2024-11-28",
        "Availability": 4,
        "MinimumNights": 0,
        "MinimumNightsArrival": 0,
        "Close": false,
        "CloseOnArrival": false,
        "CloseOnDeparture": true,
        "Rates": [
          { "PriceList": "USD", "Price": 90.50 },
          { "PriceList": "ILS", "Price": 310.30 }
        ]
      }
    ]
  }
]
```

**XML — single date:**

```xml
<?xml version="1.0" encoding="utf-8"?>
<ArrayOfRoom xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Room RoomTypeCode="DBL">
    <Dates>
      <Date Value="2024-11-28">
        <Availability>4</Availability>
        <MinimumNights>0</MinimumNights>
        <MinimumNightsArrival>0</MinimumNightsArrival>
        <Close>false</Close>
        <CloseOnArrival>false</CloseOnArrival>
        <CloseOnDeparture>true</CloseOnDeparture>
        <Rates>
          <Rate PriceList="USD"><Price>90.50</Price></Rate>
          <Rate PriceList="ILS"><Price>310.30</Price></Rate>
        </Rates>
      </Date>
    </Dates>
  </Room>
</ArrayOfRoom>
```

**JSON — multiple dates:**

```json
[
  {
    "RoomTypeCode": "DBL",
    "Dates": [
      {
        "Date": "2024-06-11",
        "Availability": 4,
        "MinimumNights": 0,
        "MinimumNightsArrival": 0,
        "Close": false,
        "CloseOnArrival": false,
        "CloseOnDeparture": false,
        "Rates": [{ "PriceList": "USD", "Price": 81 }]
      },
      {
        "Date": "2024-06-12",
        "Availability": 4,
        "MinimumNights": 2,
        "MinimumNightsArrival": 0,
        "Close": false,
        "CloseOnArrival": false,
        "CloseOnDeparture": false,
        "Rates": [{ "PriceList": "USD", "Price": 71.50 }]
      }
    ]
  }
]
```

**Response.** A container with `Warnings` and `Errors` arrays of human-readable strings.
Per-date problems are reported but do not necessarily fail the whole batch.

```json
{
  "Warnings": [
    "(Room 'DBL' at 2019-12-20) Warning: Availability cannot be less than 0 (accepted values: 0-999 or null). Availability will not be updated. (Provided value: -1)"
  ],
  "Errors": [
    "(Room 'DBL' at 2025-02-15) Error: Date cannot be greater than 1.5 years from now. The provided data for this date will not be updated. (Current maximum date: 2021-06-17)"
  ]
}
```

---

## 5. Generic Payment Gateways API

> Also called the **Reverse Payment API**. Lets external PSPs / payment platforms process
> payments on behalf of MiniHotel hotels via a unified **Global Checkout Sessions** flow:
> create a session, redirect the guest to your checkout, then let MiniHotel verify status
> before confirming the booking. **JSON only.** *(Went live 2025-09-01 — available now.)*
>
> For card capture/pre-auth/guarantee handled **outside** MiniHotel.

### 5.1 Preface & Setup

- **You implement two endpoints** that MiniHotel calls (see §5.2).
- **Setup:** add your profile under **MiniHotel Settings → Generic Payment Gateways** on the
  sandbox hotel (add/edit/disable/delete configs there). Contact MiniHotel to configure your
  profile on live hotels before go-live.

### 5.2 API Specification

**Endpoints you must expose.** Return **HTTP 200 OK** on success.

| Endpoint | Method | Description |
| :------- | :----- | :---------- |
| Create Session | `POST` | Receives the payment request, returns a session object |
| Check Payment | `GET` | Receives the payment ID in the URL, returns the payment status |

**Create Session — request.** Only `Amount`, `Currency`, and `NotificationURL` are always
present; everything else may be null/empty.

| Parameter | Description | Type | Req? | Example |
| :-------- | :---------- | :--- | :--- | :------ |
| `Amount` | Amount to pay | Double | Yes | `100.12` |
| `Currency` | Currency code | String | Yes | `USD` |
| `FirstName` | Payer first name | String | No | `Jon` |
| `LastName` | Payer last name | String | No | `Doe` |
| `Email` | Payer email | String | No | `jondoe@gmail.com` |
| `Phone` | Payer phone | String | No | `+1 123 456` |
| `Address` | Payer address | String | No | |
| `City` | Payer city | String | No | |
| `Zip` | Payer ZIP | String | No | |
| `CountryCode` | ISO country code | String | No | `US` |
| `NotificationURL` | Payment-notification URL | String | Yes | `https://example.com/notify` |
| `SuccessURL` | Redirect after success | String | No | `https://example.com/success` |
| `ErrorURL` | Redirect after failure | String | No | `https://example.com/error` |

```json
{
  "Amount": 100.12,
  "Currency": "USD",
  "FirstName": "Jon",
  "LastName": "Doe",
  "Email": "jondoe@gmail.com",
  "Phone": "+1 123 456",
  "Address": "",
  "City": "",
  "Zip": "",
  "CountryCode": "US",
  "NotificationURL": "https://somedomain.cloud/api/Notifications",
  "SuccessURL": "https://somedomain.cloud/SuccessUrl",
  "ErrorURL": ""
}
```

**Check Payment — request.** `GET`, no body:

```text
GET https://yourdomain.com/api/v1/GenericPaymentSession/{paymentId}
```

**Response structure** (same shape for both endpoints):

| Parameter | Description | Type | Example |
| :-------- | :---------- | :--- | :------ |
| `PaymentSessionId` | Payment session ID | String | `13` |
| `PaymentSessionUrl` | URL to redirect the user for payment | String | `https://yourdomain.com/payment/someid` |
| `Status` | Payment status | String | `Pending` |
| `Amount` | Amount to pay | Double | `100.12` |
| `Currency` | Currency code | String | `USD` |
| `FirstName` | Payer first name | String | `Jon` |
| `LastName` | Payer last name | String | `Doe` |
| `Email` | Payer email | String | `jondoe@gmail.com` |
| `Phone` | Payer phone | String | … *(table truncated in capture — re-scrape for any fields after Phone and the full `Status` enum)* |

---

## 6. Booking Engine

> Hosted booking mini-site. Use the **direct link** for buttons/banners, or **embed** it via
> iframe inside your own site. All parameters are optional and prefill the funnel.

### 6.1 Direct link & URL parameters

**URL shape:**

```text
{base}/BookingFrameClient/hotel/{HotelID}/{InstanceID}/book/rooms?[parameters]
```

| Environment | Base |
| :---------- | :--- |
| Sandbox | `https://sandbox.minihotel.cloud` |
| Production (International) | `https://frame1.hotelpms.io` |
| Production (Latam) | `https://frame1.hotelpms.io` |

| ID | Description | Example |
| :- | :---------- | :------ |
| `{HotelID}` | Internal MiniHotel hotel identifier | `B263C4CD7A30D45315E78416F6F4F942` |
| `{InstanceID}` | Hotel instance UUID | `153f2c6a-a062-4c7b-97d7-c6bb89533ae6` |

| Parameter | Description | Example |
| :-------- | :---------- | :------ |
| `from` | Stay start, `YYYYMMDD` | `from=20250601` |
| `to` | Stay end, `YYYYMMDD` | `to=20250603` |
| `nAdults` | Number of adults | `nAdults=2` |
| `nChilds` | Number of children | `nChilds=1` |
| `nBabies` | Number of infants | `nBabies=1` |
| `roomType` | Filter to a specific room type | `roomType=DLX` |
| `currency` | 3-letter ISO currency | `currency=USD` |
| `language` | Locale | `language=en-US` |

**Example** (June 1–3, 2025, USD, English):

```text
https://sandbox.minihotel.cloud/BookingFrameClient/hotel/B263C4CD7A30D45315E78416F6F4F942/153f2c6a-a062-4c7b-97d7-c6bb89533ae6/book/rooms?currency=USD&language=en-US&from=20250601&to=20250603
```

> The production link is **unique per hotel** — obtain it from the hotel manager/owner or
> MiniHotel support.

### 6.2 Embedding (iframe)

Paste inside `<body>` where the engine should appear; replace `src` with the hotel's
production URL:

```html
<iframe id="hw-booking-frame"
        src="https://sandbox.minihotel.cloud/BookingFrameClient/hotel/B263C4CD7A30D45315E78416F6F4F942/153f2c6a-a062-4c7b-97d7-c6bb89533ae6/book/rooms?currency=USD&language=en-US&rp="
        frameborder="0" allowtransparency="true" scrolling="no" style="width: 100%;">
</iframe>
<script src="https://sandbox.minihotel.cloud/BookingFrameClient/public/assets/booking-frame/js/iframe-resizer.min.js"></script>
<script src="https://sandbox.minihotel.cloud/BookingFrameClient/public/assets/booking-frame/js/main.js"></script>
```

> On a CMS (e.g. WordPress), place the snippet in a custom-HTML block/widget that allows
> JavaScript. The two scripts auto-resize the iframe.

---

## 7. Webhooks

> Real-time push from MiniHotel to your endpoint. **HTTP POST**, authenticated with **HTTP
> Basic Auth** (you provide the endpoint URL + username/password to MiniHotel support to
> enable them).

### 7.1 Generic request structure

Every webhook shares an envelope; type-specific data lives under `payload`.

| Field | Type | Description |
| :---- | :--- | :---------- |
| `eventId` | String | Internal event ID (GUID) |
| `notificationID` | Long | Internal notification ID |
| `hotelCode` | String | MiniHotel property code |
| `notificationType` | String | Notification category, e.g. `room.occupancy.updated` |
| `payload` | Object | All data for this event |

> ⚠️ Examples use `eventID` (capital **D**) while the schema says `eventId`. **Parse
> case-tolerantly.**

### 7.2 Real-Time Room Status — `room.occupancy.updated`

Fires whenever a room's occupancy changes (check-in / check-out). For smart locks, smart
TVs, guest-experience platforms, IoT, and alarm/safety systems (e.g. arm a smoke detector
only while occupied). Complements the Room Status Inquiry API (§2.4) when you need a full
snapshot.

> **Trust `occupied`, not `status`.** `occupied` (`true`/`false`) is the reliable indicator
> of real room state; reservation `status` may lag actual occupancy.

**Payload:**

| Field | Type | Description |
| :---- | :--- | :---------- |
| `reservationNumber` | String | MiniHotel reservation number |
| `status` | String | Current reservation status (see §2.4 codes) |
| `rooms` | Array | Array of rooms |
| `rooms[].roomNumber` | String | Room number |
| `rooms[].guestFirstName` | String | Guest first name |
| `rooms[].guestLastName` | String | Guest last name |
| `rooms[].occupied` | Boolean | Whether the room is occupied |
| `timestamp` | String | UTC datetime the change was generated |

**Check-in (occupied):**

```json
{
  "eventID": "56e39148-f14c-4135-a28e-3bae1489aa2a",
  "notificationID": 5,
  "hotelCode": "sandbox",
  "notificationType": "room.occupancy.updated",
  "payload": {
    "reservationNumber": "007004415",
    "status": "IN",
    "rooms": [
      { "roomNumber": "0101", "guestFirstName": "John", "guestLastName": "Doe", "occupied": true }
    ],
    "timestamp": "2026-02-03 00:03:29"
  }
}
```

**Check-out (vacant):**

```json
{
  "eventID": "26e39345-a14b-1567-b38f-4bbe1466bb3b",
  "notificationID": 6,
  "hotelCode": "sandbox",
  "notificationType": "room.occupancy.updated",
  "payload": {
    "reservationNumber": "007004415",
    "status": "OK",
    "rooms": [
      { "roomNumber": "0101", "guestFirstName": "", "guestLastName": "", "occupied": false }
    ],
    "timestamp": "2026-02-03 00:05:22"
  }
}
```

### 7.3 Errors & retries

- **Acknowledge** with any **HTTP 2xx** (200 OK recommended). No response body required —
  only the status code matters.
- **2xx** → marked **Delivered**. **Non-2xx / timeout / connection error / unreachable** →
  **Failed**, and retried.
- **Retry schedule:** 10 s → 1 min → 5 min → 10 min → 1 hour → 6 hours (final). After the
  final attempt it stays **Failed**.

### 7.4 `room.occupancy.changed` — trigger scenarios

Triggered when a room's occupancy state changes **for today** — i.e. the room enters or
leaves the **IN** (checked-in / occupied) state, for today's date:

1. **Arrival activates occupancy today** — reservation becomes active today and the room is
   checked **IN** (arrival is today, or arrival was in the past and status flips to **IN**
   today).
2. **Ongoing stay covering today** — a multi-day stay where today falls inside it and the
   room is **IN** (e.g. arrival 2 days ago, departure extended to tomorrow+).
3. **Room status → IN** — a specific room is manually set **IN** and is relevant for today.
4. **Reservation status → IN** — fires only for the rooms active today.
5. **Occupancy ends today** — a room/reservation that is **IN** today flips to **OUT** (or
   any non-occupied state): emitted with `occupied = false`.
6. **Room reassignment during an active stay** — an **IN**-today room is moved/reassigned.
7. **Guest data changes during active occupancy** — guest first/last name updated for an
   **IN**-today room.

> Only emits for rooms relevant to **today's** occupancy; reflects real-time state
> transitions.

---

## Appendix — provenance & open items

**Verified against the live source (via web search):**
- The ARI API is the **XML `/gds`** interface (MiniHotel's public "ARI (XML) Web Service
  Interface" doc). The §3 Content/Data/POS **function names** match MiniHotel's own inventory.

**Removed as inaccurate:**
- A prior draft's `…/ari/ariMain.asmx/{GetBulkARI,UpdateARI,GetRoomStatus,CreateModifyReservation}`
  endpoints, a `<Authentication><Hotel/><User/></Authentication>` block, and a numeric
  `0/1/2/3/4/5/99` ARI error table — all unsupported by the source and contradicted by §2.

**Open items to re-scrape when the docs become fetchable again:**
- §3 Content/Data/POS **endpoint URLs** (currently *unverified*).
- Full specs for `sendPayment()` (partial), `processCreditCard()`, `getRoomTypes()`,
  `sendEmail()`, `sendSMS()`, `ChangeReservationStatus()`, `GetDayUseReservationsMap()`,
  `ChangeReservationCountry()`, and the JSON functions `UpdateCleanStatus()`,
  `GetPosItems()`, `UpdatePosItem()`.
- §5 response table fields after `Phone`, and the full `Status` enum.
