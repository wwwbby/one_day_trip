import { expect, test } from "@playwright/test";

const storagePlanKey = "daytrip-planner.plans.v2";
const activePlanKey = "daytrip-planner.active-plan-id.v2";

const transitFast = {
  distanceMeters: 4200,
  durationSeconds: 1500,
  mode: "TRANSIT",
  preferredMode: "TRANSIT",
  provider: "navitime-transit",
  summary: "JR Yamanote Line rapid service bound for Shibuya and local subway connection",
  startTime: "2026-07-18T09:05:00+09:00",
  endTime: "2026-07-18T09:30:00+09:00",
  transfers: 1,
  fare: 220,
  coordinates: [
    [35.681236, 139.767125],
    [35.675069, 139.763328],
    [35.665251, 139.712092]
  ],
  steps: [
    {
      mode: "WALK",
      line: "walk",
      from: "Tokyo Station",
      to: "Marunouchi entrance",
      startTime: "2026-07-18T09:05:00+09:00",
      endTime: "2026-07-18T09:09:00+09:00",
      durationSeconds: 240,
      distanceMeters: 260
    },
    {
      mode: "TRANSIT",
      line: "JR Yamanote Line",
      headsign: "Shibuya",
      from: "Tokyo",
      to: "Harajuku",
      startTime: "2026-07-18T09:10:00+09:00",
      endTime: "2026-07-18T09:28:00+09:00",
      durationSeconds: 1080,
      distanceMeters: 3800
    },
    {
      mode: "WALK",
      line: "walk",
      from: "Harajuku",
      to: "Meiji Shrine",
      startTime: "2026-07-18T09:28:00+09:00",
      endTime: "2026-07-18T09:30:00+09:00",
      durationSeconds: 120,
      distanceMeters: 140
    }
  ]
};

const transitComfort = {
  ...transitFast,
  durationSeconds: 1920,
  summary: "Metro Chiyoda Line with fewer stairs and a sheltered walking transfer",
  startTime: "2026-07-18T09:08:00+09:00",
  endTime: "2026-07-18T09:40:00+09:00",
  transfers: 0,
  fare: 260,
  coordinates: [
    [35.681236, 139.767125],
    [35.668596, 139.706381],
    [35.665251, 139.712092]
  ],
  steps: [
    {
      mode: "TRANSIT",
      line: "Tokyo Metro Chiyoda Line",
      headsign: "Yoyogi-Uehara",
      from: "Otemachi",
      to: "Meiji-jingumae",
      startTime: "2026-07-18T09:08:00+09:00",
      endTime: "2026-07-18T09:36:00+09:00",
      durationSeconds: 1680,
      distanceMeters: 3900
    },
    {
      mode: "WALK",
      line: "walk",
      from: "Meiji-jingumae",
      to: "Meiji Shrine",
      startTime: "2026-07-18T09:36:00+09:00",
      endTime: "2026-07-18T09:40:00+09:00",
      durationSeconds: 240,
      distanceMeters: 300
    }
  ]
};

const mobilePlan = {
  id: "mobile-layout-plan",
  name: "Mobile regression plan",
  tripDate: "2026-07-18",
  startTime: "09:00",
  transitTimePreference: "departure",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
  stops: [
    {
      id: "stop-start",
      name: "Tokyo Station",
      address: "1 Chome Marunouchi, Chiyoda City",
      location: { lat: 35.681236, lng: 139.767125 },
      stayMinutes: 5,
      role: "normal",
      isStart: true,
      windowStart: "09:00",
      note: "Start here",
      source: "manual"
    },
    {
      id: "stop-meiji",
      name: "Meiji Shrine anime pilgrimage photo point",
      address: "Yoyogi, Shibuya City",
      location: { lat: 35.665251, lng: 139.712092 },
      stayMinutes: 5,
      role: "pilgrimage",
      note: "Pilgrimage",
      source: "anitabi",
      workTitle: "Mobile Test Work",
      anitabiPointId: "anitabi-mobile-1",
      thumbnailUrl:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='80'%3E%3Crect width='120' height='80' fill='%23167c80'/%3E%3C/svg%3E"
    },
    {
      id: "stop-fixed",
      name: "Shibuya timed lunch reservation",
      address: "Shibuya Crossing",
      location: { lat: 35.65952, lng: 139.70059 },
      stayMinutes: 30,
      role: "fixed",
      windowStart: "10:30",
      note: "Reservation",
      source: "manual"
    },
    {
      id: "stop-end",
      name: "Shinjuku Station west exit",
      address: "Shinjuku City",
      location: { lat: 35.690921, lng: 139.700258 },
      stayMinutes: 0,
      role: "end",
      isEnd: true,
      note: "Finish",
      source: "manual"
    }
  ],
  routePlan: {
    distanceMeters: 9900,
    durationSeconds: 3840,
    provider: "navitime-transit",
    warnings: [],
    routeStopIds: ["stop-start", "stop-meiji", "stop-fixed", "stop-end"],
    coordinates: [
      [35.681236, 139.767125],
      [35.665251, 139.712092],
      [35.65952, 139.70059],
      [35.690921, 139.700258]
    ],
    legs: [
      {
        ...transitFast,
        selectedAlternativeIndex: 0,
        alternatives: [transitFast, transitComfort]
      },
      {
        distanceMeters: 1400,
        durationSeconds: 900,
        mode: "WALK",
        preferredMode: "WALK",
        provider: "estimated-walk",
        summary: "Walk through Harajuku and Omotesando side streets",
        startTime: "2026-07-18T09:35:00+09:00",
        endTime: "2026-07-18T09:50:00+09:00",
        coordinates: [
          [35.665251, 139.712092],
          [35.661971, 139.703795],
          [35.65952, 139.70059]
        ],
        steps: [
          {
            mode: "WALK",
            line: "walk",
            from: "Meiji Shrine",
            to: "Shibuya timed lunch reservation",
            durationSeconds: 900,
            distanceMeters: 1400
          }
        ]
      },
      {
        distanceMeters: 4300,
        durationSeconds: 1440,
        mode: "TRANSIT",
        preferredMode: "TRANSIT",
        provider: "navitime-transit",
        summary: "JR Saikyo Line direct train to Shinjuku",
        startTime: "2026-07-18T11:05:00+09:00",
        endTime: "2026-07-18T11:29:00+09:00",
        transfers: 0,
        fare: 180,
        coordinates: [
          [35.65952, 139.70059],
          [35.658034, 139.701636],
          [35.690921, 139.700258]
        ],
        steps: [
          {
            mode: "TRANSIT",
            line: "JR Saikyo Line",
            headsign: "Shinjuku",
            from: "Shibuya",
            to: "Shinjuku",
            durationSeconds: 420,
            distanceMeters: 3400
          },
          {
            mode: "WALK",
            line: "walk",
            from: "Shinjuku",
            to: "Shinjuku Station west exit",
            durationSeconds: 240,
            distanceMeters: 260
          }
        ]
      }
    ]
  }
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ activePlanKey, mobilePlan, storagePlanKey }) => {
      window.localStorage.setItem(storagePlanKey, JSON.stringify([mobilePlan]));
      window.sessionStorage.setItem(activePlanKey, mobilePlan.id);
    },
    { activePlanKey, mobilePlan, storagePlanKey }
  );

  await page.route("**/api/plans**", async (route) => {
    const request = route.request();

    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ plans: [mobilePlan] })
      });
      return;
    }

    if (request.method() === "POST") {
      const payload = JSON.parse(request.postData() || "{}");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ plan: payload.plan || mobilePlan })
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true })
    });
  });
});

test.describe("mobile planner layout", () => {
  test("keeps the map and route list usable on a narrow phone viewport", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator(".app-shell")).toBeVisible();
    await expect(page.locator(".map-panel")).toBeVisible();
    await expect(page.locator(".planner-panel")).toBeVisible();
    await expect(page.locator(".stop-card")).toHaveCount(4);
    await expect(page.locator(".route-leg-card")).toHaveCount(3);
    await expect(page.locator(".stop-marker")).toHaveCount(4);

    const layout = await page.evaluate(() => {
      const map = document.querySelector(".map-panel")?.getBoundingClientRect();
      const panel = document.querySelector(".planner-panel")?.getBoundingClientRect();
      return {
        width: window.innerWidth,
        height: window.innerHeight,
        mapHeight: map?.height || 0,
        panelHeight: panel?.height || 0,
        mapBottom: map?.bottom || 0,
        panelTop: panel?.top || 0
      };
    });

    expect(layout.width).toBe(360);
    expect(layout.mapHeight).toBeGreaterThan(220);
    expect(layout.panelHeight).toBeGreaterThan(300);
    expect(layout.panelTop).toBeGreaterThanOrEqual(layout.mapBottom - 1);

    const visibleMarkers = await page.evaluate(() => {
      const map = document.querySelector(".map-panel")?.getBoundingClientRect();
      if (!map) return 0;
      return Array.from(document.querySelectorAll(".stop-marker")).filter((marker) => {
        const rect = marker.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right >= map.left &&
          rect.left <= map.right &&
          rect.bottom >= map.top &&
          rect.top <= map.bottom
        );
      }).length;
    });
    expect(visibleMarkers).toBeGreaterThan(0);

    const overflow = await page.evaluate(() => {
      const selectors = [
        ".app-shell",
        ".planner-panel",
        ".map-panel",
        ".panel-header",
        ".date-row",
        ".search-row",
        ".stats-strip",
        ".stop-card",
        ".route-leg-card",
        ".route-leg-content",
        ".route-leg-header",
        ".route-alternative-list",
        ".panel-footer"
      ];
      const viewportWidth = window.innerWidth;
      const offenders = Array.from(document.querySelectorAll<HTMLElement>(selectors.join(",")))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && (rect.left < -1 || rect.right > viewportWidth + 1);
        })
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            className: element.className,
            left: rect.left,
            right: rect.right,
            width: rect.width
          };
        });

      return {
        documentOverflow: document.documentElement.scrollWidth - viewportWidth,
        bodyOverflow: document.body.scrollWidth - viewportWidth,
        offenders
      };
    });

    expect(overflow.documentOverflow).toBeLessThanOrEqual(1);
    expect(overflow.bodyOverflow).toBeLessThanOrEqual(1);
    expect(overflow.offenders).toEqual([]);

    const routeTitles = await page.locator(".route-leg-header strong").evaluateAll((nodes) =>
      nodes.map((node) => {
        const styles = window.getComputedStyle(node);
        return {
          writingMode: styles.writingMode,
          whiteSpace: styles.whiteSpace
        };
      })
    );
    expect(routeTitles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ writingMode: "horizontal-tb", whiteSpace: "normal" })
      ])
    );
    expect(routeTitles.every((title) => title.writingMode === "horizontal-tb" && title.whiteSpace === "normal")).toBe(true);

    const clippedFooterButtons = await page.locator(".panel-footer .utility-button").evaluateAll((buttons) =>
      buttons
        .map((button, index) => ({
          index,
          clientWidth: button.clientWidth,
          scrollWidth: button.scrollWidth,
          clientHeight: button.clientHeight,
          scrollHeight: button.scrollHeight
        }))
        .filter((button) => button.scrollWidth > button.clientWidth + 1 || button.scrollHeight > button.clientHeight + 1)
    );
    expect(clippedFooterButtons).toEqual([]);

    const scrollState = await page.locator(".planner-panel").evaluate((panel) => {
      const before = panel.scrollTop;
      panel.scrollTop = 900;
      return {
        before,
        after: panel.scrollTop,
        clientHeight: panel.clientHeight,
        scrollHeight: panel.scrollHeight
      };
    });
    expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight + 100);
    expect(scrollState.after).toBeGreaterThan(scrollState.before);
  });

  test("allows choosing a transit alternative without breaking the phone layout", async ({ page }) => {
    await page.goto("/");

    const alternatives = page.locator(".route-alternative-button");
    await expect(alternatives).toHaveCount(2);
    await expect(alternatives.nth(0)).toHaveClass(/is-selected/);

    await alternatives.nth(1).click();
    await expect(alternatives.nth(1)).toHaveClass(/is-selected/);

    const overflowAfterSelection = await page.evaluate(() => ({
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      bodyOverflow: document.body.scrollWidth - window.innerWidth
    }));
    expect(overflowAfterSelection.documentOverflow).toBeLessThanOrEqual(1);
    expect(overflowAfterSelection.bodyOverflow).toBeLessThanOrEqual(1);
  });
});
