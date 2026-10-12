import { getSimpleRouteJson } from "solver-utils"
import { test, expect } from "bun:test"
import { Circuit } from "@tscircuit/core"
import { getFullConnectivityMapFromCircuitJson } from "circuit-json-to-connectivity-map"
import type { AnyCircuitElement as AnySoupElement } from "circuit-json"
import { getDebugSvg } from "../../../infinite-grid-ijump-astar/tests/fixtures/get-debug-svg"
import { MultilayerIjump } from "../../MultilayerIjump"

// Reproduction for https://github.com/tscircuit/autorouting/issues/92
// ("Multilayer Ijump: Remove wild trace jumps")
//
// Dense castellated module board with several nets plus a same-net join
// connection (M1 > pin3 to H1 > pin1, both pads already connected by the
// straight traces of the same net). With production options (connMap,
// optimizeWithGoalBoxes, isRemovePathLoopsEnabled, layerCount 2):
//
// - Before the fix, traces routed for other connections of the same net
//   were kept as obstacles for later connections (they are tagged with the
//   connection name but filtered against the net id), so the router
//   wiggled wildly around its own net's traces to escape their obstacle
//   margin instead of joining them.
//
// - After the fix (getObstacleConnectionId tags trace obstacles with the
//   net id and createObstacleList filters same-net trace obstacles), the
//   join connection connects the two existing same-net traces directly.
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y)

test("wild jump repro: same-net traces must not be obstacles", () => {
  const circuit = new Circuit()

  circuit.add(
    <board width="16mm" height="12mm" routingDisabled>
      {/* left module with castellated pads */}
      <chip name="M1" pcbX={-4} pcbY={0}>
        <footprint>
          <smtpad pcbX={0.3} pcbY={-1.3} shape="rect" width="0.6mm" height="0.9mm" layer="top" portHints={["pin1"]} />
          <smtpad pcbX={0.3} pcbY={-0.65} shape="rect" width="0.6mm" height="0.9mm" layer="top" portHints={["pin2"]} />
          <smtpad pcbX={0.3} pcbY={0} shape="rect" width="0.6mm" height="0.9mm" layer="top" portHints={["pin3"]} />
          <smtpad pcbX={0.3} pcbY={0.65} shape="rect" width="0.6mm" height="0.9mm" layer="top" portHints={["pin4"]} />
          <smtpad pcbX={0.3} pcbY={1.3} shape="rect" width="0.6mm" height="0.9mm" layer="top" portHints={["pin5"]} />
        </footprint>
      </chip>
      {/* right header pads */}
      <chip name="H1" pcbX={4} pcbY={0}>
        <footprint>
          <smtpad pcbX={-0.3} pcbY={-1.3} shape="rect" width="0.6mm" height="0.9mm" layer="top" portHints={["pin1"]} />
          <smtpad pcbX={-0.3} pcbY={-0.65} shape="rect" width="0.6mm" height="0.9mm" layer="top" portHints={["pin2"]} />
          <smtpad pcbX={-0.3} pcbY={0} shape="rect" width="0.6mm" height="0.9mm" layer="top" portHints={["pin3"]} />
          <smtpad pcbX={-0.3} pcbY={0.65} shape="rect" width="0.6mm" height="0.9mm" layer="top" portHints={["pin4"]} />
          <smtpad pcbX={-0.3} pcbY={1.3} shape="rect" width="0.6mm" height="0.9mm" layer="top" portHints={["pin5"]} />
        </footprint>
      </chip>
      {/* obstacle blocks above and below */}
      <chip name="O1" pcbX={0} pcbY={-2.2}>
        <footprint>
          <smtpad pcbX={0} pcbY={0} shape="rect" width="4mm" height="1.2mm" layer="top" portHints={["pin1"]} />
        </footprint>
      </chip>
      <chip name="O2" pcbX={0} pcbY={2.2}>
        <footprint>
          <smtpad pcbX={0} pcbY={0} shape="rect" width="4mm" height="1.2mm" layer="top" portHints={["pin1"]} />
        </footprint>
      </chip>
      <trace from=".M1 > .pin1" to=".H1 > .pin1" />
      <trace from=".M1 > .pin3" to=".H1 > .pin3" />
      <trace from=".M1 > .pin5" to=".H1 > .pin5" />
      <trace from=".M1 > .pin2" to=".H1 > .pin4" />
      <trace from=".M1 > .pin4" to=".H1 > .pin2" />
      {/* same-net join: both pads already connected by the traces above */}
      <trace from=".M1 > .pin3" to=".H1 > .pin1" />
    </board>,
  )

  const inputCircuitJson = circuit.getCircuitJson() as unknown as AnySoupElement[]
  const connMap = getFullConnectivityMapFromCircuitJson(inputCircuitJson)
  const input = getSimpleRouteJson(inputCircuitJson, { layerCount: 2, connMap }) as any

  const autorouter = new MultilayerIjump({
    input,
    connMap,
    isRemovePathLoopsEnabled: true,
    optimizeWithGoalBoxes: true,
    debug: true,
  } as any)

  const solution = autorouter.solveAndMapToTraces() as any[]

  expect(solution.length).toBe(input.connections.length)

  // The same-net join connection (last connection) must connect the two
  // existing same-net traces: one endpoint on the M1.pin3 -> H1.pin3 trace
  // (y = 0) and one on the M1.pin1 -> H1.pin1 trace (y = -1.3)
  const joinRoute = solution[solution.length - 1].route.filter(
    (p: any) => p.x !== undefined,
  )
  const nearY = (p: any, y: number, tol = 0.2) => Math.abs(p.y - y) <= tol
  expect(nearY(joinRoute[0], 0)).toBe(true)
  expect(nearY(joinRoute[joinRoute.length - 1], -1.3)).toBe(true)

  // Every emitted trace must start and end near one of the two pads of its
  // connection (no traces floating in the middle of the board)
  solution.forEach((trace, i) => {
    const { pointsToConnect } = input.connections[i]
    const route = trace.route.filter((p: any) => p.x !== undefined)
    const first = route[0]
    const last = route[route.length - 1]
    const touchesAnyPad = (p: any) =>
      pointsToConnect.some((pt: any) => distance(p, pt) <= 0.2)
    // Traces created for a same-net join connect existing traces instead of
    // pads, so only require a pad hit OR a point on an existing same-net
    // trace row (y = 0, -1.3 for this board)
    expect(
      touchesAnyPad(first) || nearY(first, 0) || nearY(first, -1.3),
    ).toBe(true)
    expect(
      touchesAnyPad(last) || nearY(last, 0) || nearY(last, -1.3),
    ).toBe(true)
  })

  expect(getDebugSvg({ inputCircuitJson, autorouter, solution })).toMatchSvgSnapshot(
    import.meta.path,
  )
})
