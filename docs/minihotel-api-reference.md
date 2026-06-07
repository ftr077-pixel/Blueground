# MiniHotel API Reference

> Internal reference for the **Rental Orchestrator Hub**. Captures the full MiniHotel
> PMS / Channel-Manager API surface so we can borrow the right ideas — and design real
> integrations — when building new capabilities. MiniHotel is a candidate **PMS + channel
> backbone**: it can pull/push Availability-Rates-Inventory (ARI), inject and modify
> reservations, post room charges, process payments, fire real-time room-occupancy
> webhooks, and expose a hosted Booking Engine. Those map cleanly onto the Hub's four
> departments (see the integration map below).
>
> **Last updated:** 2026-06-07
> **Source:** a verbatim, page-by-page manual copy of the entire MiniHotel reference
> (`https://minihotel.readme.io/reference`). This supersedes the earlier reconstructed
> draft — all endpoints, root element names, parameter tables, and examples below are taken
> directly from the docs.

---

## How this was built (and its limits)

- **Sourcing method:** the whole MiniHotel readme.io reference was copied page-by-page by
  hand (every page in the docs) and transcribed here. The ugly readme `[block:parameters]`
  JSON dumps were converted to clean markdown tables, repeated "Documentation Index"
  banners were stripped, and a handful of large near-duplicate XML response blobs were
  consolidated to representative examples (noted where done). Nothing here is reconstructed
  from memory.
- **Why it's done this way:** the MiniHotel docs estate is unreachable from automated
  fetchers in our environment — every outbound request is rejected by our network
  **allowlist** (`HTTP 403 "Host not in allowlist"`), so `WebFetch`/`curl` can't reach
  `minihotel.readme.io`. The reliable path was a manual copy. To re-fetch automatically in
  future, allowlist `minihotel.readme.io` (then `GET /llms.txt` / `/llms-full.txt`) or
  scrape from an unrestricted box.
- **Confidence:** **high** across all sections (verbatim source).
- **Source inconsistencies preserved & flagged:** the docs themselves contain a few
  contradictions/typos (e.g., the Generic Payment Gateways "available from" date differs
  between two pages; a Reverse-ARI XML example repeats `USD` where it likely means `ILS`;
  the C# decode snippet is a "partial example"). These are flagged inline and collected in
  the **Appendix**.

## How to use this reference

1. **Learning:** §1–§7 are the full API inventory, grouped by API family, each function with
   its endpoint, HTTP method, parameters, and request/response examples.
2. **Building:** start from the **Integration map** to find which API a feature needs, then
   jump to that function. Endpoints are listed per function (the base URL and path style
   vary — newer REST endpoints under `/api/Agents/…`, older ASMX under `/agents/ws/…`).
3. **Keep it alive:** re-copy when MiniHotel ships changes. Bump *Last updated*.

---

## TL;DR — the three API families

| Family | What it does | Format | Transport | Auth |
| :----- | :----------- | :----- | :-------- | :--- |
| **ARI API** (§2) | Pull digested ARI from MiniHotel **+** send reservations in | XML | POST to `/gds` | In-body `<Authentication username password />` |
| **Content & Data API** (§3) | Read/update hotel static + dynamic data, payments, messaging, POS | XML & JSON | POST / PUT / GET | In-body `<Authentication>` (XML) or headers (JSON) |
| **Reverse API** (§4) | Push ARI **into** MiniHotel | JSON **or** XML | POST | Request headers `User / Password / hotel_id` |

Plus: **Generic Payment Gateways API** (§5, for PSPs), the hosted **Booking Engine**
(§6, link or iframe), and **Webhooks** (§7, real-time room-occupancy push).

---

## Integration map — MiniHotel ↔ Rental Orchestrator Hub

How each MiniHotel capability could feed a department/worker from `spec.md`. (Real
integrations are a non-goal for the current milestone — this is forward-looking prior art.)

| Hub department / worker | MiniHotel capability | API |
| :---------------------- | :------------------- | :-- |
| **Revenue & Yield** → Pricing Specialist | Push rates / availability / min-nights / closures | Reverse ARI (§4.2) |
| **Revenue & Yield** → Pricing Specialist | Pull current ARI to reconcile / detect drift | Bulk ARI (§2.2), Immediate ARI (§2.3) |
| **Revenue & Yield** → Listing Optimizer | Hosted booking funnel (direct-channel presence) | Booking Engine (§6) |
| **Operational Logistics & QC** → Field QC Agent | Real-time occupied/vacant signal (smart locks, IoT, QC timing) | Webhooks `room.occupancy.updated` (§7); Room Status Inquiry (§2.4) |
| **Operational Logistics & QC** → Supply Manager | Read room/cleaning status; flip clean state | `getRooms()` (§3.5), `UpdateCleanStatus()` (§3.19) |
| **Operational Logistics & QC** | Post consumable/upsell charges to the folio | `SendRoomCharges()` (§3.7) |
| **Guest Relations & Concierge** → Inquiry Specialist | Inject / modify / cancel bookings | Create & Modify Reservations (§2.5) |
| **Guest Relations & Concierge** → Digital Concierge | Transactional email / SMS to guests | `sendEmail()` (§3.13), `sendSMS()` (§3.14) |
| **Guest Relations & Concierge** | Folio balance, check-in docs (passport/ID upload) | `GetReservationBalance()` (§3.8), `saveDocuments()`/`getDocuments()` (§3.9–3.10) |
| **Cross-cutting** → payments | Card capture / pre-auth / guarantee, receipts | `sendPayment()`/`processCreditCard()` (§3.11–3.12); Generic Payment Gateways (§5) |

---

## 0. Conventions & environments

**API sandbox credentials** (used across the docs):

```text
username = "Test"
password = "3657488"
hotel id = "sandbox"
```

**PMS GUI login** (for visually verifying your API actions in a browser at
`https://login.minihotel.cloud` — **not** for API calls):

```text
hotel id: sandbox
user:     demo
pass:     60706070
```

**Base endpoints by family:**

| API family | Sandbox base | Production base |
| :--------- | :----------- | :-------------- |
| ARI API (§2) | `https://sandbox.minihotel.cloud/gds` | `https://api.minihotel.cloud/gds` |
| Content & Data (§3) | `https://sandbox.minihotel.cloud` | `https://api2.minihotel.cloud` |
| Reverse ARI (§4) | `https://sandbox.minihotel.cloud` | `https://api2.minihotel.cloud` |
| Booking Engine (§6) | `https://sandbox.minihotel.cloud/BookingFrameClient/…` | `https://frame1.hotelpms.io/…` (Intl), `https://frame2.hotelpms.io/…` (Latam) |

> Content & Data and Reverse ARI share a base host but each **function has its own full
> path** (listed per function). The HTTP method also varies per function (POST / PUT / GET).

**Production checklist:** test on sandbox → MiniHotel issues production credentials + real
hotel IDs after the staging/testing phase → **whitelist your server IPs** with MiniHotel
before go-live.

---

## 1. Get Started

**About MiniHotel.** All-in-one cloud Hotel Management Software + Channel Manager, for
small-to-medium hotels, boutique hotels, vacation rentals, and all accommodation types.
Thousands of clients across ~65 countries.

**API overview — three families, three different endpoints:**
- **ARI API** — fetch digested hotel ARI (Availability, Rates & Inventory) and send
  reservations into MiniHotel. Mostly OTAs, tour operators, B2B marketplaces; also channel
  managers and RMS.
- **Content & Data API** — fetch & update hotel/accommodation static data, dynamic data, and
  settings (arrivals, departures, modifications, payments, room amenities, upsells/room
  charging). For POS / Restaurant / Kiosk, Self-Check-In, Guest Apps; also dynamic-pricing &
  yield software, BI tools, other channel managers & PMSs.
- **Reverse API** — update MiniHotel's ARI data. Mostly RMS, PMSs, and B2B marketplaces.

> ℹ️ Production credentials are provided after the staging/testing phase; until then use the
> per-API sandbox credentials. Whitelist your IPs before production.

---

## 2. ARI API

> **XML over POST**, to the `/gds` endpoint. For OTAs, Tour Operators, RMS, and Channel
> Managers — sync ARI both directions and inject reservations.

### 2.1 Preface & Authentication

Partners usually hold an ARI database on their side and use this interface to sync with
MiniHotel and send reservations in.

| Sandbox Endpoint | Production Endpoint |
| :--------------- | :------------------ |
| `https://sandbox.minihotel.cloud/gds` | `https://api.minihotel.cloud/gds` |

```text Credentials
username = "Test"
password = "3657488"
Hotel id = "sandbox"
```

**Decode function in C# (partial example, from the docs).** Several special characters are
XML-encoded in responses and must be decoded back, or the XML won't be well-formed. The
source snippet renders garbled; the intent is a standard XML un-escape:

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

Pull Availability, Rates, and Restrictions for a **specific period** (from–to). Best for OTAs
and agencies that store ARI on their side. **Max query period: 2 years.**

**Request parameters:**

| Element | Attributes | Description | Example |
| :------ | :--------- | :---------- | :------ |
| `Authentication` | username, password | API credentials | `<Authentication username="Test" password="3657488" />` |
| `Authentication` | MinimumNights | Return min-nights value. `YES`/`NO` (omitting = `NO`). | `MinimumNights="YES"` |
| `Hotel` | ID | Hotel id | `Hotel id="sandbox"` |
| `DateRange` | from, to | | `<DateRange from="2015-06-28" to="2015-06-30" />` |
| `Guests` | adults, child, babies | | `<Guests adults="2" child="1" babies="0" />` |
| `Prices` | rateCode | **Mandatory.** One rate code per call; cannot be empty. | `Prices rateCode="USD"` |

**Request:**

```xml
<?xml version="1.0" encoding="UTF-8" ?>
<!-- Mini Hotel - Availability and Rates - Request -->
<AvailRaterq xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Authentication username="Test" password="3657488" ResponseType="05" />
  <Hotel id="sandbox" />
  <DateRange from="2022-06-20" to="2022-06-30" />
  <Prices rateCode="USD"></Prices>
</AvailRaterq>
```

**Response:**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<AvailRaters>
  <Hotel id="sandbox" Name_h="Sandbox Hotel MiniHotel" Currency="USD" />
  <DateRange from="2022-01-15" to="2022-01-19" />
  <RoomTypes>
    <RoomType id="DBL" RoomName="Double Room" BasicOccupancy="002">
      <Day Mdate="20220115" Mavailability="4" Mprice="26.10" Minngt="0" Mclose="No" McloseArr="No" McloseDep="No" ExtraAdultFee="22.00" ExtraChildFee="10.00" ExtraBabyFee="7.00" SingleUse="0.00" />
      <Day Mdate="20220116" Mavailability="4" Mprice="22.50" Minngt="0" Mclose="No" McloseArr="No" McloseDep="No" ExtraAdultFee="22.00" ExtraChildFee="10.00" ExtraBabyFee="7.00" SingleUse="0.00" />
      <!-- … one <Day> per date … -->
    </RoomType>
    <RoomType id="TRP" RoomName="TRIPLE" BasicOccupancy="003">
      <Day Mdate="20220117" Mavailability="1" Mprice="28.80" Minngt="0" Mclose="No" McloseArr="No" McloseDep="No" ExtraAdultFee="85.00" ExtraChildFee="50.00" ExtraBabyFee="25.00" SingleUse="0.00" />
      <Day Mdate="20220118" Mavailability="0" Mprice="28.80" Minngt="0" Mclose="No" McloseArr="No" McloseDep="No" ExtraAdultFee="85.00" ExtraChildFee="50.00" ExtraBabyFee="25.00" SingleUse="0.00" />
    </RoomType>
  </RoomTypes>
  <Meals>
    <Meal MealId="B">
      <Day Mdate="20220115" MealAdult="0.00" MealBaby="0.00" MealChild="0.00" />
    </Meal>
  </Meals>
</AvailRaters>
```

**Response explanation:**

| Attribute | Description |
| :-------- | :---------- |
| `Mavailability` | Room quantity available for the date |
| `Mprice` | Price for the date |
| `Minngt` | Minimum nights for the date |
| `Mclose` | Closure restriction for the date |
| `McloseArr` | Closure for arrival only |
| `McloseDep` | Closure for departure only |
| `ExtraAdultFee` / `ExtraChildFee` / `ExtraBabyFee` | Extra-guest fees for the date |
| `SingleUse` | Price for 1 adult only using the room, for the date |
| `MealId` | `B` = Breakfast; `L` = Lunch; `D` = Dinner |

### 2.3 Immediate ARI Data

Retrieve Availability and Rates for a **specific stay period and a single rate code** per
request. For partners who don't store data and need ad-hoc/real-time responses (by hotel,
region, etc.). **Price values are the total for the full requested stay, not per night.**

**Request parameters:**

| Element | Attributes | Description |
| :------ | :--------- | :---------- |
| `Authentication` | username, password | API credentials |
| `Authentication` | MinimumNights | `YES`/`NO` (omit = `NO`) |
| `Hotel` | ID | e.g. `Hotel id="sandbox"` |
| `Area` | ID | Custom area values agreed with MiniHotel (e.g. `US`, `Paris`). Alternative to Hotel. |
| `DateRange` | from, to | Stay period |
| `Guests` | adults, child, babies | |
| `Agent` | id | Optional agent filter (you are an agent too), e.g. `Expedia` |
| `RoomTypes → RoomType` | id | Optional (omit = `*ALL*`). `*MIN*` = lowest available rate (returns one room type only); `*ALL*` = all. |
| `Prices` | rateCode | **Mandatory.** Any rate code configured in the hotel (`USD`, `EUR`, `STD`, …). One per call. |
| `Prices → Price` | boardCode | **Mandatory.** Board/meal code. `*ALL*` = all; `*MIN*` = minimal boards per room type. |

> ℹ️ `rateCode` determines the currency (the currency per rate is set in MiniHotel settings).
> Multiple rate codes per query aren't supported — send multiple requests.
> 🚧 Use **either** Hotel id **or** Area id (if both are sent, Area is ignored).

**Request — by Hotel ID:**

```xml
<?xml version="1.0" encoding="UTF-8" ?>
<AvailRaterq xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Authentication username="Test" password="3657488" />
  <Hotel id="sandbox" />
  <DateRange from="2024-06-18" to="2024-06-21" />
  <Guests adults="2" child="" babies="" />
  <RoomTypes><RoomType id="*ALL*" /></RoomTypes>
  <Prices rateCode="USD"><Price boardCode="*ALL*" /></Prices>
</AvailRaterq>
```

**Response — by Hotel ID:**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<AvailRaters>
  <Hotel id="sandbox" Name_h="Test Hotel MiniHotel" Name_e="Test Hotel MiniHotel" Currency="USD" />
  <DateRange from="2024-06-18" to="2024-06-21" />
  <Guests adults="2" child="0" babies="0" />
  <RoomType id="2BEDAPT" Name_h="Two bedroom apartment" Name_e="Two bedroom apartment">
    <Inventory Allocation="5" maxavail="5" />
    <price board="BB" boardDesc="BB" value="352.50" value_nrf="317.25" />
    <price board="FB" boardDesc="Full Board" value="652.50" value_nrf="587.25" />
    <price board="HB" boardDesc="Half Board" value="652.50" value_nrf="587.25" />
    <price board="RO" boardDesc="RO" value="202.50" value_nrf="182.25" />
  </RoomType>
  <!-- … more <RoomType> … -->
</AvailRaters>
```

**Request — by Area ID** (`<Area id="US" Currency="USD" />` replaces `<Hotel>`): the response
returns one `<AvailRaters>` block **per hotel** in the area, and may include a
`<CancellPol Full="…" OneNight="…" />` element per hotel.

**Response explanation:**

| Element | Attribute | Description |
| :------ | :-------- | :---------- |
| `Hotel` | id | Hotel's unique id |
| `Hotel` | Name_h | Hotel name (local language) |
| `Hotel` | Name_e | Hotel name (English) |
| `Hotel` | Currency | Currency of prices in the response |
| `Inventory` | Allocation | Number of available rooms |
| `Inventory` | maxavail | Total number of rooms |
| `Price` | board | Meal arrangement code |
| `Price` | boardDesc | Meal arrangement description |
| `Price` | value | Regular price value |
| `Price` | value_nrf | Non-refundable price value (NRF factor set in settings per portal/agent) |

### 2.4 Real-Time Room Status Inquiry

Retrieve rooms and reservations within a date range (room numbers/names, types, guest info,
status). For occupancy monitoring (in-room security, phone/TV apps, mini-bar). Uses
`ResponseType="03"`.

> 🚧 Don't query large date ranges without pre-approval — it wastes server resources.
> For real-time actions, also use the complementary [webhook](#7-webhooks).

**Request:**

```xml
<?xml version="1.0" encoding="UTF-8" ?>
<AvailRaters xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Authentication username="Test" password="3657488" ResponseType="03" />
  <Hotel id="sandbox" />
  <DateRange from="2024-07-14" to="2024-07-17" />
</AvailRaters>
```

**Response** (all rooms whether occupied or vacant; reservations staying/arriving in range):

```xml
<AvailRaters>
  <Hotel id="sandbox" Name_h="Test Hotel MiniHotel" Name_e="Test Hotel MiniHotel" />
  <DateRange from="2024-07-14" to="2024-07-18" />
  <Rooms>
    <Room Number="01" Rmtype="DBL" />
    <Room Number="104" Rmtype="Twin" />
    <!-- … all hotel rooms … -->
  </Rooms>
  <RoomsTypes>
    <RoomType Code="DBL" Description="Double room" />
    <RoomType Code="Twin" Description="Twin Room" />
    <!-- … all room types … -->
  </RoomsTypes>
  <Reservations>
    <Reservation ResNumber="007003163" Namep="Jon" Namef="Doe" RoomNumber="01" RoomType="DBL"
                 FromYmd="20240713" ToYmd="20240715" RoomsQty="0001" Status="OK" Board="HB" />
    <Reservation ResNumber="007003171" Namep="Walter" Namef="Matteo" RoomNumber="104" RoomType="Twin"
                 FromYmd="20240714" ToYmd="20240715" RoomsQty="0001" Status="OK" Board="HB" />
  </Reservations>
</AvailRaters>
```

| Container | Description |
| :-------- | :---------- |
| `Rooms` | All hotel rooms at query time (any date range); occupied or not |
| `RoomsTypes` | All hotel room types at query time |
| `Reservations` | Reservations for the queried range, with room number + status. Checked-out/cancelled in-range are **not** listed. |

```text Standard Status Codes
OK: Confirmed   WL: Pending   IN: Checked-in   OUT: Checked-out   CL: Cancelled   BL: Black list
(Other values can be customized in the system setup)
```

### 2.5 Create & Modify Reservations

Send reservations into MiniHotel — single room or multi-room (groups), with contact details,
address, remarks, etc.

**Create — single room:**

```xml
<?xml version="1.0"?>
<Bookings>
  <Authentication username="Test" password="3657488" />
  <Hotel id="sandbox" />
  <Booking id="123456789" type="Book" createDateTime="23/12/2019" source="Web" rateCode="Standard" Board="HB">
    <RoomStays>
      <RoomStay roomTypeID="TRP" roomTypeName="Triple Room" Board="HB">
        <StayDate arrival="2020-01-21" departure="2020-01-23"/>
        <RoomCount NumberOfUnits="1" />
        <GuestCount adult="2" child="1" baby="0" />
        <Total AmountAfterTaxes="900" CurrencyCode="USD" />
        <GuestNames givenName="Jon" surname="Doe" />
      </RoomStay>
    </RoomStays>
    <PrimaryGuest>
      <Name givenName="Jon" surname="Doe"></Name>
      <Address Street="79 Street" Zip="565643" City="Seattle" />
      <Country iso3="USA" iso2="US" />
      <Phone>7189726000</Phone>
      <Email>test@gogo.Com</Email>
      <CreditCard Number="4111111111111111" NameOnCard="Jon Doe" Expirationdate="1022" cvv="898" />
    </PrimaryGuest>
    <Remarks>Note1 Note2 Note3</Remarks>
  </Booking>
</Bookings>
```

**Create — multi-room (group):** repeat `<RoomStay>` per room; a `<ResGlobalInfo>` with the
overall `<Timespan>` and `<Total>` can be added:

```xml
<?xml version="1.0"?>
<Bookings>
  <Authentication username="Test" password="3657488" />
  <Hotel id="sandbox" />
  <Booking id="40406060550" type="Book" createDateTime="2018-03-11" Source="Web" RateCode="Standard" Board="BB">
    <RoomStay roomTypeID="DBL" roomTypeName="">
      <StayDate arrival="2018-04-11" departure="2018-04-12" />
      <RoomCount NumberOfUnits="1" />
      <GuestCount adult="2" child="0" baby="0" />
      <PerDayRates CurrencyCode="USD"><PerDayRate stayDate="" baseRate="" /></PerDayRates>
      <Total AmountAfterTaxes="930" CurrencyCode="USD" />
      <GuestNames><Name givenName="mickey" surname="mouse" /></GuestNames>
    </RoomStay>
    <RoomStay roomTypeID="TRP" roomTypeName="">
      <StayDate arrival="2018-04-11" departure="2018-04-13" />
      <RoomCount NumberOfUnits="1" />
      <GuestCount adult="1" child="2" baby="0" />
      <Total AmountAfterTaxes="1370" CurrencyCode="USD" />
      <GuestNames><Name givenName="mini" surname="mouse" /></GuestNames>
    </RoomStay>
    <PrimaryGuest>
      <Name givenName="mini" surname="mouse" />
      <Address Street="bear st" Zip="12150" City="Larnaca" />
      <Country CountryName="" iso2="US" iso3="USA" />
      <Language iso2="HE" />
      <Email>yokoshoko@gmail.com</Email><Phone>046999999</Phone><Fax />
      <CreditCard Type="MasterCard" Number="80808080808080" NameOnCard="Jon" Expirationdate="0418" cvv="802" />
    </PrimaryGuest>
    <SpecialRequest />
    <Remarks>Payment Method: Credit Card (MasterCard)\n Rate Code: USD</Remarks>
    <ResGlobalInfo>
      <Timespan arrival="2018-04-11" departure="2018-04-13" />
      <Total AmountAfterTaxes="" CurrencyCode="USD" />
    </ResGlobalInfo>
  </Booking>
</Bookings>
```

**Success response** (a `resnumber` is returned on success; empty `<BookingConfirmNumbers>`
indicates a syntax error or a re-used booking id):

```xml
<BookingConfirmRQ>
  <BookingConfirmNumbers>
    <BookingConfirmNumber bookingID="324234342" resnumber="007012539" />
  </BookingConfirmNumbers>
</BookingConfirmRQ>
```

**Elements & attributes:**

- **Booking id** — your unique id (recommended; each id used once). Maintain a counter on
  your side for traceability. To submit without an id, use `Booking id="KioskPos"` (coordinate
  with MiniHotel first).
- **Source / source** — identifies the portal/agent (e.g. `Airbnb`, `Expedia`). Required to
  identify requests.
- **RateCode** — selected rate; also determines the reservation currency (each rate is linked
  to a currency in MiniHotel). Put on `<Booking>`.
- **NumofKeys** — optional, number of issued keys per room.
- **Vat** — optional, on `<Country>`: `Yes` = including VAT, `Not` = not including VAT. If
  unset, MiniHotel uses the country field + default settings.
- **Roomstay** — single & multi rooms. `roomTypeID` → system auto-assigns a room of that
  type; `roomNumber` → reserves that specific room (blocking it).
- **Board** — if unset, MiniHotel's preset applies. Header-level Board takes precedence over
  room-stay level on conflict; best practice is to set Board at room-stay level only.
- **Arrtime / Deptime** — arrival/departure times. **Day-use** (zero-night) reservations
  must include: same arrival & departure date, a **room number** (mandatory), and **both**
  arrival & departure times (mandatory).

**Modify** — set `type="Modify"`, keep the same XML structure:

```xml
<Booking id="324234342" type="Modify" createDateTime="23/02/2024" source="Expedia">
```

**Cancel** — set `type="Cancel"`, keep the same structure:

```xml
<Booking id="324234342" type="Cancel" createDateTime="23/02/2024" source="Expedia">
```

Both return the same `<BookingConfirmRQ>` shape as creation (a `resnumber` on success).

### 2.6 ARI PUSH

MiniHotel **pushes** digested ARI to a listener **you host**, at pre-configured intervals
(usually every 5–10 min). XML over POST. Endpoint is hosted by you:

```http
https://providerdomain.com/?hotelid=XXX
```

| Token | Meaning |
| :---- | :------ |
| `ProviderDomain` | Your domain to receive the request |
| `XXX` | The hotel id |

**Sending Availability** (all attributes mandatory): `id` (room id), `date` (yyyy-mm-dd),
`Allocation` (units available), `maxavail` (total units of this type).

```xml
<AvailRateUpdateRQ>
  <RoomType id="Double">
    <Inventory date="2014-03-26" Allocation="3" maxavail="4" />
  </RoomType>
  <RoomType id="Suite">
    <Inventory date="2014-03-26" Allocation="3" maxavail="4" />
  </RoomType>
</AvailRateUpdateRQ>
```

Response: `<AvailRateUpdateRS><Success/></AvailRateUpdateRS>`.
> ℹ️ Room IDs must be confirmed with MiniHotel before production.

**Sending Rates** (all mandatory): `id`, `date`, `ratecode`, `Price`.

**RateCode extras & restrictions.** Closure restrictions are **binary** (`0` = Open, `1` =
Closed); minimum nights and extra rates are positive integers:

| RateCode | Type | Description |
| :------- | :--- | :---------- |
| `CLS_NONE` | Restriction | Close for Stayover (the "regular" close — most common) |
| `CLS_ARR` | Restriction | Close for Arrival (arrival date only) |
| `CLS_DEP` | Restriction | Close for Departure (departure date only) |
| `MIN_NGT` | Restriction | Minimum Nights for Stayover (the "regular" min-nights) |
| `MIN_NGT1` | Restriction | Minimum Nights for Arrival (arrival date only) |
| `EXTRA_A` | Extra Rate | Adult extra price |
| `EXTRA_C` | Extra Rate | Child extra price |
| `EXTRA_B` | Extra Rate | Baby extra price |
| `MEAL_A_BR` / `MEAL_C_BR` | Extra Rate | Extra meal price, Adult/Child — **Breakfast** (`B` for baby) |
| `MEAL_A_LU` / `MEAL_C_LU` | Extra Rate | Extra meal price, Adult/Child — **Lunch** |
| `MEAL_A_DI` / `MEAL_C_DI` | Extra Rate | Extra meal price, Adult/Child — **Dinner** |
| `SGN_RED_ABS` | Extra Rate | Single-use reduction rate (one person in a room) |

```xml
<?xml version="1.0" encoding="UTF-8"?>
<AvailRateUpdateRQ>
  <RoomType id="Double">
    <Rates date="2013-07-30">
      <Rate ratecode="Standard" Price="350"/>
      <Rate ratecode="NonRef" Price="70"/>
      <Rate ratecode="EXTRA_A" Price="50"/>
      <Rate ratecode="CLS_NONE" Price="1"/>
      <Rate ratecode="SGN_RED_ABS" Price="100"/>
    </Rates>
  </RoomType>
</AvailRateUpdateRQ>
```

Response: `<AvailRateUpdateRS><Success/></AvailRateUpdateRS>`.
> ℹ️ Rate codes must be verified with MiniHotel before go-live. Extra/meal codes are in local
> currency by default; for a foreign currency append an underscore + code (e.g.
> `EXTRA_A_USD`, `EXTRA_A_EUR`). With a single currency the underscore isn't required.

### 2.7 Error Codes

```text
ERR 001  invalid XML
ERR 003  Missing dates parameter
ERR 004  Missing From date parameter
ERR 005  Missing To date parameter
ERR 006  Missing guests parameter
ERR 009  Missing hotel id
ERR 010  Wrong hotel id = no connection
ERR 011  Failed to parse UpdateBookingInfoRQ
ERR 101  Wrong Arrival date
ERR 102  Wrong Departure date
ERR 103  Wrong Dates Range
ERR 104  Minimal Nights Exception
ERR 105  Closed To arrival
ERR 106  Arrival date < today
ERR 107  More than 20 Nights
ERR 108  Less than 1 Night
ERR 109  Agent not linked to requested hotel
ERR 204  Hotel Code and area code are missing
ERR 205  No hotels found in area code
ERR 209  Too many requests sent to interface
ERR 501  Invalid Request
ERR 516  Invalid XML - No Reservation created
```

---

## 3. Content & Data API

> Fetch & update hotel static/dynamic data and settings: reservations, rooms, charges,
> balances, documents, payments, messaging, POS. **XML** functions authenticate in-body;
> **JSON** functions authenticate via headers. Base host: `https://sandbox.minihotel.cloud`
> (sandbox) / `https://api2.minihotel.cloud` (production); each function has its own path.

### 3.1 Preface

Suitable for content/data companies — Guest Experience Apps, Self-Check-In, dynamic-pricing
& yield software, BI tools — plus other channel managers/PMSs, and POS/Restaurant/Kiosk
systems (charge items, pull menu items, change prices). You can also create payments and
receipts inside MiniHotel.

### 3.2 XML Authentication

In-body credentials; per-function endpoint suffixes on the shared base:

| Sandbox | Production |
| :------ | :--------- |
| `https://sandbox.minihotel.cloud` | `https://api2.minihotel.cloud` |

```text Credentials
username="Test"  password="3657488"  Hotel id="sandbox"
```

### 3.3 GetReservationKey ()  — POST

Fetch reservation details (guest name, count, stay dates, address, language, country, email,
phone, arrival/departure time, source code, market segment, and more).

```text
Sandbox:    https://sandbox.minihotel.cloud/api/Agents/Sci/Reservation/GetReservationKey
Production: https://api2.minihotel.cloud/api/Agents/Sci/Reservation/GetReservationKey
```

**Request parameters** (use any partial combination; empty/omit unused):

| Parameter | Description | Type / Example |
| :-------- | :---------- | :------------- |
| `CreateDate` (`From`/`To`) | Create-date filter | Object; `yyyy-MM-dd` |
| `Cancellations` | Cancellations only (CreateDate becomes the cancellation action date) | `"YES"` or `""` |
| `NotIncludeModifications` | New reservations only | `"true"` or `""` |
| `ModifyDate` (`From`/`To`) | Modify-date filter | Object; `yyyy-MM-dd` |
| `ArrivalDate` (`From`/`To`) | Arrival-date filter | Object; `yyyy-MM-dd` |
| `DepartureDate` (`From`/`To`) | Departure-date filter | Object; `yyyy-MM-dd` |
| `BookingSearch` | Filters container | Object |
| `BookingSearch @ArrivalDate` | Arrival date | `yyyy-MM-dd` |
| `BookingSearch @GivenName` / `@Surname` | First / last name | String |
| `BookingSearch @CCNumber` | Credit-card number (≥4 digits) | String |
| `BookingSearch @PassportNumber` | Passport/ID number | String |
| `BookingSearch @Email` | Guest email | String |
| `BookingSearch @ReservationNumber` | Portal (Agent/OTA) reservation number (Booking.com/Expedia/…) | String |
| `BookingSearch @Minihotel_reservation_id` | MiniHotel internal number | e.g. `007002147` |
| `BookingSearch @PortalId` | Portal id | e.g. `BOOKING` |
| `BookingSearch @roomNumber` | Room number | String |
| `BookingSearch @Status` | Reservation status | e.g. `OUT` |
| `IncludeRoomPrices` | Include prices/rates per room | Boolean |
| `IncludeHouseKeepingRemarks` | Include housekeeping remarks | Boolean |

**Request examples** (filter combinations):

```xml
<!-- by name and arrival date -->
<GetReservationKey>
  <Authentication username="Test" password="3657488" />
  <Hotel id="sandbox" />
  <BookingSearch ArrivalDate="2024-11-17" GivenName="Jon" Surname="Doe" />
</GetReservationKey>

<!-- by email -->
<BookingSearch Email="demo009@gmail.com" />

<!-- by passport number -->
<BookingSearch PassportNumber="551552887" />

<!-- by MiniHotel internal id -->
<BookingSearch Minihotel_reservation_id="007006177" />

<!-- by date ranges + portal -->
<CreateDate From="2024-08-01" To="2024-08-10" />
<ArrivalDate From="2024-08-05" To="2024-08-09" />
<DepartureDate From="2024-08-26" To="2024-08-28" />
<BookingSearch PortalId="booking" />

<!-- by arrival date + room + status, including prices -->
<ArrivalDate From="2024-08-10" To="2024-08-16" />
<BookingSearch roomNumber="205" Status="IN" />
<IncludeRoomPrices>true</IncludeRoomPrices>

<!-- by ModifyDate (modified reservations) -->
<ModifyDate From="2024-04-22" To="2024-04-22" />
```

> On agent/OTA modification, the reservation is cancelled and replaced with a new one using
> the same `Portal_reservation_id` but a different MiniHotel booking id. Query the modified
> one via `ModifyDate`; use `NotIncludeModifications` to exclude modified ones from a
> `CreateDate` query.

**Response notes:** `Minihotel_reservation_id` = internal number; `Portal_reservation_id` =
OTA/agent number; `isGroupReservation` (`YES`/`NO`); arrival/departure dates and guest count
under `ResGlobalInfo`; may contain 0..N reservations (≤1 when searching by reservation id).

**Response — individual reservation:**

```xml
<Bookings xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Hotel id="sandbox" />
  <Booking Portal_reservation_id="1234567890" Minihotel_reservation_id="007002149" type="Query"
           createDateTime="09/10/2024" Status="OK" ModifyAllowed="YES" NumofKeys="000" source=""
           arrival_time="15:00" departure_time="10:00" market_segment="" isGroupReservation="NO">
    <RoomStays>
      <RoomStay roomNumber="207" roomTypeId="SNG" roomTypeName="Single" mealStatus="BB" />
    </RoomStays>
    <PrimaryGuest>
      <Name giveName="Jon" surname="Doe" />
      <Address Street="" Zip=" " City="" />
      <Country CountryName="US" iso2="" iso3="" />
      <Email /><Phone /><Fax />
      <CreditCard Type="" Number="****" NameOnCard=" " ExpirationDate="" />
    </PrimaryGuest>
    <ResGlobalInfo>
      <GuestCount adult="1" child="0" baby="0" youth="0" />
      <Timespan arrival="19/10/2024" departure="21/10/2024" />
      <Total AmountAfterTaxes="204.00" CurrencyCode="EUR" />
    </ResGlobalInfo>
  </Booking>
</Bookings>
```

**Group reservations** return per-room `<RoomStay … memberSerial="…">` entries inside
`<RoomStays>`, each with its own `<StayDate>`, `<GuestCount>`, `<GuestNames>`, `<IdNumber>`,
contact fields and `<Status>`. Two further variants exist in the docs:
- **with extra guests** — each `<RoomStay>` carries an `<ExtraGuests>` list
  (`<ExtraGuest>` with `Key`, `FirstName`, `LastName`, `IdNumber`, `BirthDate`, `Address`,
  `CountryCode`, `ZipCode`, `Email`, `Phone`, `Remarks`, …).
- **with prices** (`IncludeRoomPrices=true`) — each `<RoomStay>` carries
  `<Total AmountAfterTaxes="…" rateCode="…" CurrencyCode="…" />`.

```text Standard Status Codes
OK: Confirmed   WL: Pending   IN: Checked-in   OUT: Checked-out   CL: Cancelled   BL: Black list
(Other values can be customized in the system setup)
```

### 3.4 UpdateReservation ()  — PUT

Update an existing reservation (header and/or members): guest name, ID number, email, phone,
remarks, status, times, and more.

```text
Sandbox:    https://sandbox.minihotel.cloud/api/Agents/Sci/Reservation/{reservationId}
Production: https://api2.minihotel.cloud/api/Agents/Sci/Reservation/{reservationId}
```

**Header parameters:** `Status`, `ArrivalTime` (hh:mm), `DepartureTime` (hh:mm), `FirstName`,
`LastName`, `IdNumber`, `Email`, `Phone`, and `Remarks` (`AppendRemarks` true/false — append
vs overwrite, default false; `Printed`; `NonPrinted`).

```xml
<Request>
  <Authentication username="Test" password="3657488" />
  <Hotel id="sandbox" />
  <Reservation>
    <Header>
      <Status>IN</Status>
      <ArrivalTime>15:00</ArrivalTime>
      <DepartureTime>10:00</DepartureTime>
      <Email>email@example.com</Email>
      <Phone>123456789</Phone>
      <FirstName>John</FirstName>
      <IdNumber>3333333</IdNumber>
      <Remarks>
        <AppendRemarks>true</AppendRemarks>
        <Printed>Non-smoking room please</Printed>
        <NonPrinted>Problematic guest</NonPrinted>
      </Remarks>
    </Header>
  </Reservation>
</Request>
```

**Members parameters:** `Members` → `Member @serial`, with `RoomType`, `FirstName`,
`LastName`, `IdNumber`, `Email`, `Phone`, `Status`. (`RoomType` optional; if used, may keep
or reduce the room count but not exceed the reserved total.)

```xml
<Request>
  <Authentication username="Test" password="3657488" />
  <Hotel id="sandbox" />
  <Reservation>
    <Header><ArrivalTime>15:00</ArrivalTime><DepartureTime>10:00</DepartureTime></Header>
    <Members>
      <Member serial="001">
        <FirstName>dada</FirstName><LastName>jana</LastName><IdNumber>3333333</IdNumber>
        <Email>email@example.net</Email><Phone>80808070</Phone>
        <RoomType>Twin</RoomType><Status>IN</Status>
      </Member>
      <Member serial="002">
        <FirstName>nana</FirstName><LastName>jana</LastName><IdNumber>3333733</IdNumber>
        <Status></Status>
      </Member>
    </Members>
  </Reservation>
</Request>
```

> 👍 Success returns a simple `200`. To reset a header status, set it to `OK` (e.g. to move a
> checked-out reservation to checked-in: set `OK`, then `IN`). Group members support only
> `IN`, `OUT`, and `""` (null = reset to "OK"/no status).

**Error response:** `<Error><StatusCode>…</StatusCode><Message>…</Message></Error>`.

```text Error codes
101 Arrival time: Bad format            102 Departure time: Bad format
103 Member serial ID is missing         104 Member ID '{Serial ID}' was not found
105 Member status '{Status}' is not valid
106 No available room for '{RoomType}' room type was found
107 RoomTypes node cannot be part of the request when modifying group reservations
151 Cannot add new rooms                152 Status '{Status}' is not valid
```

### 3.5 getRooms ()  — POST

Room information & static data per room number (codes, attributes, occupancy settings,
cleaning status). Leave `room_number` empty to get all rooms.

```text
Sandbox:    https://sandbox.minihotel.cloud/agents/ws/settings/rooms/RoomsMain.asmx/getRooms
Production: https://api2.minihotel.cloud/agents/ws/settings/rooms/RoomsMain.asmx/getRooms
```

**Request:** `room_number` (String, optional; empty = all).

```xml
<Request>
  <Settings name="getRooms">
    <Authentication username="Test" password="3657488"/>
    <Hotel id="sandbox" />
    <room_number>101</room_number>
  </Settings>
</Request>
```

**Key response fields** (`ArrayOfRnm_struct_room` → `rnm_struct_room`):

| Field | Description |
| :---- | :---------- |
| `rm_serial` | Room serial number |
| `rm_number` | Room number |
| `rm_type` | Room type |
| `rm_clsdt1` / `rm_clsdt2` | Closed date from / to (`yyyyMMdd`) |
| `rm_status` | Cleaning status: `C` = Clean, `D` = Dirty (1 char) |
| `rm_dorm` | Is the unit a dorm (binary) |
| `rm_wing` | Wing code (1 char) |
| `rm_bed` | Is the unit a bed (binary) |
| `rm_occ` | Not included in occupancy (binary) |
| `rm_color` | Room color |
| `rec_rooms_gst_max` (`rgm_gst_type` `A`/`B`/`C`, `rgm_max`) | Max guests per type |
| `rnm_attribute` (`@code`, `@description`) | Room attributes (e.g. Garden view, Sea view) |

```xml
<Response>
  <ServerInfo><Name>SANDBOX1</Name><ResponseTime>22 ms</ResponseTime><DateTime>7/8/2018 2:48:17 PM</DateTime></ServerInfo>
  <ArrayOfRnm_struct_room xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
    <rnm_struct_room>
      <rm_serial>001</rm_serial><rm_number>102</rm_number><rm_type>DBL-Interno</rm_type>
      <rm_clsdt1 /><rm_clsdt2 /><rm_status>C</rm_status>
      <rm_dorm>0</rm_dorm><rm_wing>1</rm_wing><rm_bed>0</rm_bed><rm_occ>0</rm_occ>
      <rm_image>https://sandbox.minihotel.cloud/agents/ws/settings/rooms/RoomImage.aspx?h=…</rm_image>
      <ArrayOfRec_rooms_gst_max>
        <rec_rooms_gst_max><rgm_gst_type>A</rgm_gst_type><rgm_max>2</rgm_max></rec_rooms_gst_max>
        <rec_rooms_gst_max><rgm_gst_type>C</rgm_gst_type><rgm_max>0</rgm_max></rec_rooms_gst_max>
        <rec_rooms_gst_max><rgm_gst_type>B</rgm_gst_type><rgm_max>0</rgm_max></rec_rooms_gst_max>
      </ArrayOfRec_rooms_gst_max>
      <ArrayOfRnm_struct_room_attributes>
        <rnm_attribute code="1" description="Garden view" />
        <rnm_attribute code="2" description="Sea view" />
      </ArrayOfRnm_struct_room_attributes>
    </rnm_struct_room>
  </ArrayOfRnm_struct_room>
</Response>
```

### 3.6 getRoomTypes ()  — POST

```text
Sandbox:    https://sandbox.minihotel.cloud/agents/ws/settings/rooms/RoomsMain.asmx/getRoomTypes
Production: https://api2.minihotel.cloud/agents/ws/settings/rooms/RoomsMain.asmx/getRoomTypes
```

```xml
<Request>
  <Settings name="getRoomTypes">
    <Authentication username="Test" password="3657488"/>
    <Hotel id="sandbox" />
  </Settings>
</Request>
```

Response (`ArrayOfRoomTypes` → `RoomTypes`): `Type` (code), `Description`, `Image` (first
image of a room that has this type).

```xml
<ArrayOfRoomTypes>
  <RoomTypes><Type>DBL</Type><Description>Double Room</Description><Image>http://imageurl.com/image</Image></RoomTypes>
  <RoomTypes><Type>TRPL</Type><Description>Triple Room</Description><Image /></RoomTypes>
</ArrayOfRoomTypes>
```

### 3.7 SendRoomCharges ()  — POST

Charge/debit a guest account (POS, restaurant, upsells, room service).

```text
Sandbox:    https://sandbox.minihotel.cloud/agents/ws/settings/pos/pos.asmx/SendRoomCharges
Production: https://api2.minihotel.cloud/agents/ws/settings/pos/pos.asmx/SendRoomCharges
```

**Request parameters:**

| Parameter | Description | Type |
| :-------- | :---------- | :--- |
| `lang_code` | Language code | String |
| `RoomCharges` → `RoomCharge` | Charges container / charge object | List / Object |
| `ChargeDate` | Optional, default = request date | String |
| `ChargeTime` | Optional, default = request time | Double |
| `RoomNumber` | Used only if `ReservationNumber` is empty. Only works if the reservation is checked-in (`IN`) with current stay dates. | String |
| `ReservationNumber` | Used only if `RoomNumber` is empty | String |
| `ItemCode` / `ItemName` / `ItemQuantity` | Item details | String/String/Integer |
| `VoucherNumber` | Voucher number | String |
| `Amount` | Total amount (negative = refund, e.g. `-5`) | Decimal |
| `IgnoreStatus` | Ignore reservation status (e.g. "In house"); allows any `ChargeDate` between arrival and departure. Only with `ReservationNumber`. | Integer |
| `SelectedFolio` | Specific folio: main `01-1`; member folios `02-001`, `02-002`, … Only with `ReservationNumber`. | String |

> ℹ️ Past reservations cannot be charged — only current or future. Charging by room number
> requires `IN` status + current stay dates.

```xml
<Request>
  <Settings name="room_charges_send" language="ENG">
    <Authentication username="Test" password="3657488" />
    <Hotel id="sandbox" />
    <RoomsCharges>
      <RoomCharge>
        <RoomNumber>09-3</RoomNumber>
        <ItemName> Heineken Beer </ItemName>
        <ItemQuantity> 2 </ItemQuantity>
        <Amount> 50.5 </Amount>
      </RoomCharge>
      <RoomCharge>
        <ReservationNumber>007000880</ReservationNumber>
        <SelectedFolio>01-1</SelectedFolio>
        <ItemName> Heineken Beer </ItemName>
        <ItemQuantity> 1 </ItemQuantity>
        <Amount> 20.25 </Amount>
        <IgnoreStatus>1</IgnoreStatus>
      </RoomCharge>
    </RoomsCharges>
  </Settings>
</Request>
```

Response: `<RoomChargesRs><Hotel id="sandbox"/><Status>OK</Status><Confirmation>****</Confirmation></RoomChargesRs>`.

### 3.8 GetReservationBalance ()  — POST

Returns the folio transactions (debits, credits, payments, remaining balance).

```text
Sandbox:    https://sandbox.minihotel.cloud/agents/ws/sci/sciMain.asmx/GetReservationBalance
Production: https://api2.minihotel.cloud/agents/ws/sci/sciMain.asmx/GetReservationBalance
```

**Request:** `ReservationNumber` (9 chars).

```xml
<Request>
  <Payment language="ENG">
    <Hotel id="sandbox" />
    <Authentication username="Test" password="3657488" />
    <ReservationNumber>070002969</ReservationNumber>
  </Payment>
</Request>
```

**Response fields** (`Balance` → `Transactions` → `Transaction`):

| Field | Description |
| :---- | :---------- |
| `ReservationNumber` | Reservation number |
| `Account` | Account number (e.g. `01-1`, `02-001`) |
| `Date` / `Time` | `yyyyMMdd` / `hh:MM` |
| `Department` | Department (e.g. CASH, Bebida, POS) |
| `DebitCredit` | `1` = Department charge, `2` = Payment |
| `Details` | Transaction details |
| `Amount` | Transaction amount |
| `Currency` | Local default currency code |
| `Debit` / `Credit` | Reservation debit / credit totals |
| `TotalDebit` | Total debit (remaining balance) |

```xml
<Balance>
  <ReservationNumber>070002969</ReservationNumber>
  <Transactions>
    <Transaction><Account>01-1</Account><Date>20151119</Date><Time>16:50</Time>
      <Department>CASH</Department><DebitCredit>2</DebitCredit><Details>Payment</Details><Amount>2700</Amount></Transaction>
    <Transaction><Account>01-1</Account><Date>20151230</Date><Time>15:57</Time>
      <Department>Bebida</Department><DebitCredit>1</DebitCredit><Details>Fernet con Coca Cola</Details><Amount>80</Amount></Transaction>
    <Transaction><Account>02-001</Account><Date>20241108</Date><Time>01:25</Time>
      <Department>POS</Department><DebitCredit>1</DebitCredit><Details>Beer</Details><Amount>13</Amount></Transaction>
  </Transactions>
  <Currency>ARS</Currency><Debit>6960</Debit><Credit>6960</Credit><TotalDebit>0</TotalDebit>
</Balance>
```

### 3.9 saveDocuments ()  — POST

Save documents (images) into a reservation. **Max 4 documents, max 3 MB each.**

```text
Sandbox:    https://sandbox.minihotel.cloud/agents/ws/sci/sciMain.asmx/saveDocuments
Production: https://api2.minihotel.cloud/agents/ws/sci/sciMain.asmx/saveDocuments
```

**Request:** `Documents` → `Document` with `@rs_number`, `@doc_type` (JPG/JPEG/PNG/PDF),
`@doc_value` (Base64), `@description`.

```xml
<Request>
  <SCI name="sci_saveDocuments">
    <Authentication username="Test" password="3657488"/>
    <Hotel id="sandbox" />
    <Documents>
      <Document rs_number="007006512" Doc_type="jpg" Doc_value="BASE 64 STRING" Description="Guest passport" />
    </Documents>
  </SCI>
</Request>
```

Response: `<Documents haserrors="True"><Document rs_number="007006511" status="SUCCESS" /></Documents>`.
Per-document status: `SUCCESS`, `ERROR Invalid reservation ID`, or `ERROR occurred`.

```text Error codes (prior to upload)
S000 Invalid XML Request                 S001 Number of documents exceeds max
S002 A document exceeds the max size      S003 Internal Error
S004 Invalid Credentials                  S005 Invalid Image Value
S006 Document array is empty              S007 Invalid hotel code
S008 Permissions error                    S009 Invalid credentials
S010 No permission for the selected hotel S011 Invalid document type
```

### 3.10 getDocuments ()  — POST

Fetch a previously saved document from a reservation.

```text
Sandbox:    https://sandbox.minihotel.cloud/agents/ws/sci/sciMain.asmx/getDocuments
Production: https://api2.minihotel.cloud/agents/ws/sci/sciMain.asmx/getDocuments
```

**Request:** `rs_number` (String).

```xml
<Request>
  <SCI name="sci_getDocuments">
    <Authentication username="Test" password="3657488"/>
    <Hotel id="sandbox" />
    <rs_number>007000584</rs_number>
  </SCI>
</Request>
```

Response: `Documents` → `Document` with `@src` (image URL), `@description`, `@id`.

```xml
<Documents>
  <Document src='https://sandbox.minihotel.cloud/agents/ws/sci/sciDoc.aspx?h=…' description='Guest passport' />
</Documents>
```

### 3.11 sendPayment ()  — POST

Create a payment (with or without card processing) and generate a receipt/invoice. Use
`SimulatorCode` to test without charging.

```text
Sandbox:    https://sandbox.minihotel.cloud/agents/ws/sci/sciMain.asmx/sendPayment
Production: https://api2.minihotel.cloud/agents/ws/sci/sciMain.asmx/sendPayment
```

**Request parameters:**

| Parameter | Description | Type |
| :-------- | :---------- | :--- |
| `Amount` | Total amount (decimal, e.g. `100.00`) | Double |
| `Currency` | Currency code | String |
| `Description` | e.g. `Kiosk Payment` | String |
| `VAT` | Optional: `Yes`/`No` (default `No`) — calculate VAT on the invoice/receipt | String |
| `PaymentType` | `1` Cash, `2` Credit Card, `3` Reservation Token (providers e.g. Pelecard) | Integer |
| `ReservationNumber` | MiniHotel reservation no. (9 chars) | String |
| `SelectedFolio` | Folio: main `01-1`; members `02-001`, `02-002`, … | String |
| `CreditCardInfo` | Container — **only for `PaymentType=2`** | Object |
| ↳ `CreditCard` | Card serial (swipe) or number | String |
| ↳ `ExpirationDate` | `MMyyyy` (optional) | String |
| ↳ `CVV` | Optional | String |
| ↳ `CardType` | `C` Credit, `D` Debit | String |
| ↳ `Total` | Total (decimal) | Double |
| ↳ `HotelNumber` | Hotel number | String |
| ↳ `NumberOfPayments` | Installments | Integer |
| `OperationType` | `1` Charge, `2` Check, `3` Refund | Integer |
| ↳ `ShopNumber` | Physical terminal number | Integer |
| ↳ `SimulatorCode` | Create payment/receipt without charging a card (testing/external charge) | String |

```xml
<Request>
  <Payment language="ENG">
    <Hotel id="sandbox" />
    <Authentication username="Test" password="3657488" />
    <Amount>850</Amount>
    <Currency>USD</Currency>
    <Description>Kiosk Payment</Description>
    <VAT>Yes</VAT>
    <PaymentType>2</PaymentType>
    <ReservationNumber>070017975</ReservationNumber>
    <SelectedFolio>01-1</SelectedFolio>
    <CreditCardInfo>
      <CreditCard>37551111***4444"=201220117117116612200</CreditCard>
      <CardType>C</CardType>
      <HotelNumber>9</HotelNumber>
      <NumberOfPayments>12</NumberOfPayments>
      <OperationType>2</OperationType>
      <ShopNumber>1</ShopNumber>
      <SimulatorCode>0</SimulatorCode>
    </CreditCardInfo>
  </Payment>
</Request>
```

**Response** (`Invoice`): `GuestName`, `Date` (`yyyymmdd`), `Hour`, `ReservationNumber`,
`ArrivalDate`, `DepartureDate`, `Details` (`InvoiceNumber`, `ReceiptNumber` [if hotel accepts
receipts], `Payment @type` = `CreditCard`/`Cash`, then for Cash `Currency`+`TotalAmount`, for
Credit Card `CreditCardType`+`CreditCardNumber`+`ExpireDate`), `TotalNet`, `VatAmount`,
`TotalGross`.

```xml
<Invoice>
  <GuestName>Jon Doe</GuestName><Date>20180915</Date><Hour>11:19</Hour>
  <ReservationNumber>070017975</ReservationNumber>
  <ArrivalDate>15/09/2018</ArrivalDate><DepartureDate>16/09/2018</DepartureDate>
  <Details>
    <InvoiceNumber>000000001</InvoiceNumber>
    <Payment type='Cash'><Currency>USD</Currency><TotalAmount>850</TotalAmount></Payment>
    <TotalNet>3043</TotalNet><VatAmount>0</VatAmount><TotalGross>3043</TotalGross>
  </Details>
</Invoice>
```

```text Error codes
INV0001 Invalid Currency (check MiniHotel local currency, e.g. ILS)
INV0003 Invalid Payment Type
INV0004 No existing linkage for the selected Currency
INV0005 No updated rate for the selected Currency
Z01 Invalid Credit/Debit Card serial   Z02 Invalid Card Type        Z03 Invalid Operation Type
Z04 Invalid Reservation Number          Z05 Empty/Invalid Total      Z06 Negative Total
Z07 No Hotel Number                     Z08 No Currency              Z09 Invalid Number of Payments Format
Z30 Invalid Agent Credentials           Z31 Invalid Hotel Code       Z32 No permission for selected hotel
Z33 Your IP Address is not allowed      Z34 Invalid XML Request      Z35 Invalid CCV
Z36 Invalid Expiration Date             Z37 Credit Card has expired  Z99 Simulator - Invalid status code
-- Pelecard gateway --
003 Call the credit card company  004 Refusal  006 Call the credit card company
009 No connection with credit card company  010 Process Stopped / Com Port Error
011 No approval for this ISO currency  033/039 Wrong card number  036 Credit Card Expired
061 Card does not exist / duplicate  155 Sum too small for credit type  160 Maximal amount is zero
999 See Pelecard logs
```

### 3.12 processCreditCard ()  — POST

Process/verify a card **without** generating a receipt/invoice. `SimulatorCode` for testing.

```text
Sandbox:    https://sandbox.minihotel.cloud/agents/ws/sci/sciMain.asmx/processCreditCard
Production: https://api2.minihotel.cloud/agents/ws/sci/sciMain.asmx/processCreditCard
```

**Request:** `CreditCard`, `ExpirationDate` (`MMyyyy`, optional), `CVV` (optional), `CardType`
(`C`/`D`), `Total`, `Currency`, `ResNumber` (9 chars), `HotelNumber`, `NumberOfPayments`,
`OperationType` (`1` Charge, `2` Check, `3` Refund), `ShopNumber`, `SimulatorCode`.

```xml
<CreditCard language="ENG">
  <Hotel id="sandbox" />
  <Authentication username="Test" password="3657488" />
  <CreditCard>5326101311111111</CreditCard>
  <ExpirationDate>122118</ExpirationDate>
  <CardType>C</CardType>
  <Total>10</Total>
  <Currency>ILS</Currency>
  <ResNumber>907999090</ResNumber>
  <HotelNumber>9</HotelNumber>
  <NumberOfPayments>1</NumberOfPayments>
  <OperationType>2</OperationType>
  <ShopNumber>1</ShopNumber>
</CreditCard>
```

Response: `<ProcessCardStatus StatusCode="0" Description="OK" />`. Error codes: same `Z01–Z37`,
`Z99`, and Pelecard `003–160` set as in §3.11.

### 3.13 sendEmail ()  — POST

```text
Sandbox:    https://sandbox.minihotel.cloud/agents/ws/mail/MailInterface.asmx/sendEmail
Production: https://api2.minihotel.cloud/agents/ws/mail/MailInterface.asmx/sendEmail
```

**Request:** `DestinationMail`, `Subject`, `Text`. HTML allowed via CDATA, e.g.
`<Text><![CDATA[<p>your html</p>]]></Text>`.

```xml
<Request>
  <Mail name="sendMail">
    <Authentication username="Test" password="3657488" />
    <Hotel id="sandbox" />
    <DestinationMail>test@test.com</DestinationMail>
    <Subject>Test Subject</Subject>
    <Text>This is a test message from the MiniHotel Team.&#10;Testing the email interface.</Text>
  </Mail>
</Request>
```

Response: `<Mail DestinationEmail='…' Status='OK' />`. Errors: `S014` Invalid email address,
`S015` Invalid subject, `S016` Invalid email content.

### 3.14 sendSMS ()  — POST

```text
Sandbox:    https://sandbox.minihotel.cloud/agents/ws/sms/SMSInterface.asmx/sendSMS
Production: https://api2.minihotel.cloud/agents/ws/sms/SMSInterface.asmx/sendSMS
```

**Request:** `From` (sender name), `ToPhone` (digits only, e.g. `543511234567`), `Text` (up
to 153 chars).

```xml
<Request>
  <SMS name="sendSMS">
    <Authentication username="Test" password="3657488"/>
    <Hotel id="sandbox" />
    <From>Test Hotel</From>
    <ToPhone>54935133333333</ToPhone>
    <Text>Hello World!</Text>
  </SMS>
</Request>
```

Response: `<Message Status="OK" Description="Message sent to: … successfully." />`.

### 3.15 ChangeReservationStatus ()  — POST

Change a reservation's status (and optionally the guest ID).

```text
Sandbox:    https://sandbox.minihotel.cloud/agents/ws/sci/sciMain.asmx/ChangeReservationStatus
Production: https://api2.minihotel.cloud/agents/ws/sci/sciMain.asmx/ChangeReservationStatus
```

**Request:** `ReservationNumber` (9 chars), `NewStatus` (customizable; standard `OK/WL/IN/OUT/
CL/BL`), `IdentificationNumber` (optional new guest ID).

```xml
<Request>
  <Reservations language="ENG">
    <Hotel id="sandbox" />
    <Authentication username="Test" password="3657488" />
    <ReservationNumber>007007974</ReservationNumber>
    <NewStatus>CL</NewStatus>
    <IdentificationNumber>33355411</IdentificationNumber>
  </Reservations>
</Request>
```

Response: `<Reservation number="…" newstatus="…" newguestid="…" result="UPDATED" />`.

```text Error codes
RESSTATUS001 Invalid Reservation Number   RESSTATUS002 Invalid Status Code
RESSTATUS003 No permission to cancel reservations
RESSTATUS004 No permission to work with reservations
UP0003 No permission to work with reservations created by other users
```

### 3.16 ChangeReservationCountry ()  — POST

```text
Sandbox:    https://sandbox.minihotel.cloud/agents/ws/sci/sciMain.asmx/ChangeReservationCountry
Production: https://api2.minihotel.cloud/agents/ws/sci/sciMain.asmx/ChangeReservationCountry
```

**Request:** `ReservationNumber` (9 chars), `NewCountry` (ISO2, e.g. `US`).

```xml
<Request>
  <Reservations language="ENG">
    <Hotel id="sandbox" />
    <Authentication username="Test" password="3657488" />
    <ReservationNumber>070017974</ReservationNumber>
    <NewCountry>US</NewCountry>
  </Reservations>
</Request>
```

Response: `<Reservation number="…" newcountry="US" result="UPDATED" />`. Errors:
`RESSTATUS001` Invalid Reservation Number, `RESCOUNTRYINVALID` Invalid Country Code,
`RESSTATUS003/004`, `UP0003` (as above).

### 3.17 GetDayUseReservationsMap ()  — POST

List day-use reservations (same-day check-in/out, with arrival/departure times — spa, events,
banquets) for a date.

```text
Sandbox:    https://sandbox.minihotel.cloud/agents/ws/reservations/reservations_service.asmx/GetDayUseReservationsMap
Production: https://api2.minihotel.cloud/agents/ws/reservations/reservations_service.asmx/GetDayUseReservationsMap
```

**Request:** `Reservations @language`, `Date` (`yyyyMMdd`).

```xml
<Request>
  <Reservations name="GetDayUseReservationsMap" language="ENG">
    <Authentication username="Test" password="3657488" />
    <Hotel id="sandbox" />
    <Date>20241019</Date>
  </Reservations>
</Request>
```

Response: `Reservation` rows with `Namep`, `Namef`, `ResNumber`, `RoomNumber`, `RoomType`,
`FromYmd`, `ToYmd`, `ArrivalTime`, `DepartureTime`, `RoomsQty`, `Status`, `Board`, `Source`.

```xml
<Reservations>
  <Reservation ResNumber="007000361" Namep="Jon" Namef="Doe" RoomNumber="301" RoomType="SNG"
               FromYmd="20181019" ToYmd="20181019" ArrivalTime="14:00" DepartureTime="16:00"
               RoomsQty="0001" Status="OK" Board="BB" Source="BB" />
</Reservations>
```

### 3.18 JSON Authentication

JSON functions authenticate via **request headers**; per-function suffixes on the shared base.

| Sandbox | Production |
| :------ | :--------- |
| `https://sandbox.minihotel.cloud` | `https://api2.minihotel.cloud` |

```text Request headers
User="Test"  Password="3657488"  hotel_id="sandbox"
```

### 3.19 UpdateCleanStatus ()  — POST (JSON)

For partners managing housekeeping/maintenance externally — push real-time room cleaning
statuses. (To read the current status, use `getRooms()` and its `rm_status`.)

```text
Sandbox:    https://sandbox.minihotel.cloud/api/Agents/Rooms/UpdateCleanStatus
Production: https://api2.minihotel.cloud/api/Agents/Rooms/UpdateCleanStatus
```

**Body:** `roomNumber` (MiniHotel internal room number), `status` (`C` = Clean, `D` = Dirty).

```json
{ "roomNumber": "002", "status": "C" }
```

Success: `{ "statusCode": "0", "message": "OK" }`.
Errors: `{ "statusCode": 3, "message": "Room was not found" }`,
`{ "statusCode": 4, "message": "Invalid clean status code" }`.

> **Cleaning statuses:** core = `C` (Clean), `D` (Dirty); `R` (Refresh) is common.
> Status codes must be single letters; additional statuses can be customized with MiniHotel
> support. Map your internal statuses to MiniHotel codes (e.g. "Refresh"→`R`, "Inspected"→`I`).

### 3.20 GetPosItems ()  — GET (JSON)

Retrieve the POS items configured in MiniHotel (for POS/restaurant/guest-experience menus).

```text
Sandbox:    https://sandbox.minihotel.cloud/api/Agents/POS/GetPosItems
Production: https://api2.minihotel.cloud/api/Agents/POS/GetPosItems
```

Response fields: `Code`, `Name`, `Currency`, `Price` (Double), `DepartmentCode`,
`DepartmentDescription`, `Close` (Boolean status), `Modified` (DateTime).

```json
[
  {
    "Code": "001", "Name": "Pool Towel", "Currency": "USD", "Price": 10.0,
    "DepartmentCode": "SPA", "DepartmentDescription": "SPA Department",
    "Close": false, "Modified": "2023-07-31T09:56:00"
  }
]
```

### 3.21 UpdatePosItem ()  — POST (JSON)

Update an existing menu item's name, price, or status. Changes propagate to other POS systems
connected to MiniHotel (indirect integration via a single connection).

```text
Sandbox:    https://sandbox.minihotel.cloud/api/Agents/POS/UpdatePosItem
Production: https://api2.minihotel.cloud/api/Agents/POS/UpdatePosItem
```

**Request:** `Code` (required), `Name`, `Price` (Double), `Close` (Boolean). At least one
updatable field must be provided.

```json
{ "code": "002", "name": "French Fries", "Price": "12", "close": false }
```

Success returns the full item (as in §3.20). Error example:
`{ "statusCode": "AEX099", "message": "Wrong request. You did not provide any valid field to be updated." }`.

---

## 4. Reverse API

> Push **ARI into** MiniHotel (availability, rates, restrictions) plus operational data like
> room cleaning status. **JSON or XML over POST.** Used by RMS, PMSs, and B2B marketplaces
> (and channel managers) — partners that hold their own per-property ARI database and sync
> MiniHotel's connected OTAs (Booking.com, Airbnb, Expedia, Despegar, Agoda, Hostelworld, …).

### 4.1 Preface & Authentication

Auth via **request headers**; per-function suffixes on the shared base.

| Sandbox | Production |
| :------ | :--------- |
| `https://sandbox.minihotel.cloud` | `https://api2.minihotel.cloud` |

```text Request headers
User="Test"  Password="3657488"  hotel_id="sandbox"
```

> Every response includes an **`X-Request-ID`** header (a GUID). Capture it — MiniHotel
> support needs it to trace issues.

### 4.2 Bulk ARI — Reverse API

Update Rates, Availability, and Restrictions (min-nights, closures) into MiniHotel. Review
results in the PMS "Rates & Availability" menu. **JSON or XML.** **Max update period: 2 years.**

| Sandbox Endpoint | Production Endpoint |
| :--------------- | :------------------ |
| `https://sandbox.minihotel.cloud/AgentsScreenA/api/Agents/ScreenA` | `https://api2.minihotel.cloud/AgentsScreenA/api/Agents/ScreenA` |

**Model — Room:**

| Parameter | Description | Type | Req? |
| :-------- | :---------- | :--- | :--- |
| `RoomTypeCode` | Room type code to update | String | Required |
| `Dates` | Array of `Date` | Array[Date] | Required |

**Model — Date** (omit optional fields you don't want to change):

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

> ℹ️ Max query period: 1.5 years. 🚧 Don't include optional params for fields you don't want
> to update.

**Model — Rate:**

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

**XML — single date** (⚠️ the source repeats `PriceList="USD"` on the second `<Rate>`; that is
almost certainly meant to be `ILS`, per the JSON above):

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
      { "Date": "2024-06-11", "Availability": 4, "MinimumNights": 0, "MinimumNightsArrival": 0,
        "Close": false, "CloseOnArrival": false, "CloseOnDeparture": false,
        "Rates": [{ "PriceList": "USD", "Price": 81 }] },
      { "Date": "2024-06-12", "Availability": 4, "MinimumNights": 2, "MinimumNightsArrival": 0,
        "Close": false, "CloseOnArrival": false, "CloseOnDeparture": false,
        "Rates": [{ "PriceList": "USD", "Price": 71.50 }] }
    ]
  }
]
```

**Response.** Container with `Warnings` and `Errors` string arrays. Per-date problems are
reported but don't necessarily fail the whole batch.

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

> The XML response example in the docs wraps errors in `<Error>…</Error>` (singular) rather
> than `<Errors>` — treat the JSON shape above as canonical.

---

## 5. Generic Payment Gateways API

> Also "Reverse Payment API". Lets external PSPs/payment platforms process payments for
> MiniHotel hotels via a unified **Global Checkout Sessions** flow: create a session, redirect
> the guest to your checkout, then let MiniHotel verify status before confirming the booking.
> **JSON only.** For card capture/pre-auth/guarantee handled **outside** MiniHotel.
>
> ⚠️ **Availability date is inconsistent in the source:** the Preface says "available starting
> **September 1, 2025**"; the API Specification says "available starting **May 1, 2026**".
> Confirm with MiniHotel.

### 5.1 Preface & Setup

- **You implement two endpoints** that MiniHotel calls (see §5.2).
- **Setup:** add your profile under **MiniHotel Settings → Generic Payment Gateways** on the
  sandbox hotel (add/edit/disable/delete configs). Contact MiniHotel to configure your
  profile on live hotels before go-live.

### 5.2 API Specification

**Endpoints you must expose** (return **HTTP 200 OK** on success):

| Endpoint | Method | Description |
| :------- | :----- | :---------- |
| Create Session | `POST` | Receives the payment request, returns a session object |
| Check Payment | `GET` | Receives the payment ID in the URL, returns the payment status |

**Create Session — request.** Only `Amount`, `Currency`, and `NotificationURL` are always
present; everything else may be null/empty.

| Parameter | Description | Type | Mandatory | Example |
| :-------- | :---------- | :--- | :-------- | :------ |
| `Amount` | Amount to pay | Double | Yes | `100.12` |
| `Currency` | Currency code | String | Yes | `USD` |
| `FirstName` / `LastName` | Payer name | String | No | `Jon` / `Doe` |
| `Email` | Payer email | String | No | `jondoe@gmail.com` |
| `Phone` | Payer phone | String | No | `+1 123 456` |
| `Address` / `City` / `Zip` | Payer address | String | No | |
| `CountryCode` | ISO country code | String | No | `US` |
| `NotificationURL` | Payment-notification URL | String | Yes | `https://example.com/notify` |
| `SuccessURL` | Redirect after success | String | No | `https://example.com/success` |
| `ErrorURL` | Redirect after failure | String | No | `https://example.com/error` |

```json
{
  "Amount": 100.12, "Currency": "USD",
  "FirstName": "Jon", "LastName": "Doe",
  "Email": "jondoe@gmail.com", "Phone": "+1 123 456",
  "Address": "", "City": "", "Zip": "", "CountryCode": "US",
  "NotificationURL": "https://somedomain.cloud/api/Notifications",
  "SuccessURL": "https://somedomain.cloud/SuccessUrl",
  "ErrorURL": ""
}
```

**Check Payment — request** (GET, no body):

```text
GET https://yourdomain.com/api/v1/GenericPaymentSession/{paymentId}
```

**Response structure** (same shape for both endpoints): `PaymentSessionId`,
`PaymentSessionUrl` (where to redirect the user), `Status` (e.g. `Pending`), `Amount`,
`Currency`, `FirstName`, `LastName`, `Email`, `Phone`, `Address`, `City`, `Zip`,
`CountryCode`, `NotificationURL`, `SuccessURL`, `ErrorURL`.

```json
{
  "PaymentSessionId": "13",
  "PaymentSessionUrl": "https://yourdomain.com/payment/someid",
  "Status": "Pending",
  "Amount": 100.12, "Currency": "USD",
  "FirstName": "Jon", "LastName": "Doe",
  "Email": "jondoe@gmail.com", "Phone": "+1 123 456",
  "Address": "", "City": "", "Zip": "", "CountryCode": "US",
  "NotificationURL": "https://somedomain.cloud/api/Notifications",
  "SuccessURL": "https://somedomain.cloud/SuccessUrl",
  "ErrorURL": "https://somedomain.cloud/ErrorUrl"
}
```

**Error response** — return **HTTP 400 Bad Request**:

```json
{ "Code": "GPG_ERR003", "Message": "The NotificationURL field is mandatory." }
```

| Field | Description |
| :---- | :---------- |
| `Code` | Error code (e.g. `GPG_ERR003`) |
| `Message` | Shown to the end user |

---

## 6. Booking Engine

> Hosted booking mini-site. Use the **direct link** for buttons/banners, or **embed** it via
> iframe. All URL parameters are optional and prefill the funnel.

### 6.1 Direct link & URL parameters

**URL shape:** `{base}/BookingFrameClient/hotel/{HotelID}/{InstanceID}/book/rooms?[parameters]`

| Environment | Base |
| :---------- | :--- |
| Sandbox | `https://sandbox.minihotel.cloud` |
| Production — International | `https://frame1.hotelpms.io` |
| Production — Latam | `https://frame2.hotelpms.io` |

| ID | Description | Example |
| :- | :---------- | :------ |
| `{HotelID}` | Internal MiniHotel hotel identifier | `B263C4CD7A30D45315E78416F6F4F942` |
| `{InstanceID}` | Hotel instance UUID | `153f2c6a-a062-4c7b-97d7-c6bb89533ae6` |

| Parameter | Required | Description | Example |
| :-------- | :------- | :---------- | :------ |
| `from` | Optional | Stay start, `YYYYMMDD` | `from=20250601` |
| `to` | Optional | Stay end, `YYYYMMDD` | `to=20250603` |
| `nAdults` | Optional | Number of adults | `nAdults=2` |
| `nChilds` | Optional | Number of children | `nChilds=1` |
| `nBabies` | Optional | Number of infants | `nBabies=1` |
| `roomType` | Optional | Filter to a room type | `roomType=DLX` |
| `currency` | Optional | 3-letter ISO currency | `currency=USD` |
| `language` | Optional | Locale | `language=en-US` |

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
> Basic Auth** (provide your endpoint URL + username/password to MiniHotel support to enable).

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

Fires whenever a room's occupancy changes (check-in / check-out). For smart locks, smart TVs,
guest-experience platforms, IoT, and alarm/safety systems (e.g. arm a smoke detector only
while occupied). Complements the Room Status Inquiry API (§2.4).

> **Trust `occupied`, not `status`.** `occupied` (`true`/`false`) is the reliable indicator
> of real room state; reservation `status` may lag actual occupancy.

**Payload:** `reservationNumber`, `status`, `rooms[]` (each: `roomNumber`, `guestFirstName`,
`guestLastName`, `occupied`), `timestamp` (UTC).

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

- **Acknowledge** with any **HTTP 2xx** (200 OK recommended). No response body required — only
  the status code matters.
- **2xx** → **Delivered**. **Non-2xx / timeout / connection error / unreachable** → **Failed**,
  and retried.
- **Retry schedule:** 10 s → 1 min → 5 min → 10 min → 1 hour → 6 hours (final). After the
  final attempt it stays **Failed**.

### 7.4 `room.occupancy.changed` — trigger scenarios

Triggered when a room's occupancy state changes **for today** — i.e. the room enters or leaves
the **IN** (checked-in/occupied) state for today's date:

1. **Arrival activates occupancy today** — reservation becomes active today and the room is
   checked **IN** (arrival today, or arrival in the past and status flips to **IN** today).
2. **Ongoing stay covering today** — multi-day stay where today falls inside it and the room
   is **IN** (e.g. arrival 2 days ago, departure extended to tomorrow+).
3. **Room status → IN** — a specific room is set **IN** and is relevant for today.
4. **Reservation status → IN** — fires only for rooms active today.
5. **Occupancy ends today** — a room/reservation **IN** today flips to **OUT** (or any
   non-occupied state): emitted with `occupied = false`.
6. **Room reassignment during an active stay** — an **IN**-today room is moved/reassigned.
7. **Guest data changes during active occupancy** — guest first/last name updated for an
   **IN**-today room.

> Only emits for rooms relevant to **today's** occupancy; reflects real-time state transitions.

---

## Appendix — source inconsistencies (preserved verbatim, flagged here)

These are quirks **in MiniHotel's own docs**, not transcription errors. Confirm with MiniHotel
where they matter:

1. **Generic Payment Gateways availability date** — Preface says **Sept 1, 2025**; API Spec
   says **May 1, 2026** (§5).
2. **Reverse-ARI XML example** repeats `<Rate PriceList="USD">` for the second rate where the
   JSON uses `ILS` — likely a doc typo (§4.2).
3. **Reverse-ARI XML response** wraps errors in `<Error>` (singular) instead of `<Errors>`;
   the JSON shape is canonical (§4.2).
4. **ARI decode snippet** is labelled a "partial example" and renders garbled in the source;
   reproduced here as the intended XML un-escape (§2.1).
5. **Endpoint path styles are mixed** — newer REST functions live under `/api/Agents/…`
   (e.g. `GetReservationKey`, `UpdateReservation`, `UpdateCleanStatus`, POS) while older ones
   are ASMX under `/agents/ws/…` (e.g. `getRooms`, `sendPayment`, `GetReservationBalance`).
   This is by design; use each function's listed endpoint exactly.
6. **Casing** of `Doc_type`/`Doc_value`/`Description` (saveDocuments) vs the documented
   lower-case attribute names varies in the example; match the example casing if a call fails.
7. **Webhook contact** is listed as `support@minihote.io` in the source (sic).
