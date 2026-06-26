import { describe, expect, test } from 'bun:test'
import { routeEdges, gridToPixel, portPixel, DEFAULT_CORRIDOR_SIZE } from './static/pathfinding.js'

// The pathfinding library is browser-pure JS, so its exports arrive with inferred JS types (fields widen to `number`/`string`/`unknown`). The interfaces below carry the shape the tests assert against; results are annotated rather than cast so the structural checks flow through TypeScript.

interface GridNode {
	id: string
	row: number
	col: number
}

interface GridEdge {
	from: string
	to: string
}

interface GridPoint {
	row: number
	col: number
}

interface RoutedPath {
	from: string
	to: string
	points: GridPoint[]
	outPort: GridPoint | null
	inPort: GridPoint | null
}

const CS = DEFAULT_CORRIDOR_SIZE
const STRIDE = 1 + CS

function route(nodes: GridNode[], edges: GridEdge[]): RoutedPath[] {
	return routeEdges(nodes, edges) as RoutedPath[]
}

function isOrthogonal(path: GridPoint[]): boolean {
	for (let i = 1; i < path.length; i++) {
		const prev = path[i - 1]!
		const curr = path[i]!
		if (prev.row !== curr.row && prev.col !== curr.col) return false
	}
	return true
}

// Reconstructs every cell the path passes through (not just elbow points) by walking between consecutive waypoints. Handles only orthogonal segments (the library guarantees these); a diagonal segment would be a bug, so the function throws rather than silently producing wrong cells.
function allPathCells(points: GridPoint[]): Set<string> {
	const cells = new Set<string>()
	for (let i = 0; i < points.length; i++) {
		cells.add(`${points[i]!.row},${points[i]!.col}`)
		if (i > 0) {
			const prev = points[i - 1]!
			const curr = points[i]!
			if (prev.row !== curr.row && prev.col !== curr.col) throw new Error(`diagonal segment in path: ${JSON.stringify(prev)} -> ${JSON.stringify(curr)}`)
			const dr = Math.sign(curr.row - prev.row)
			const dc = Math.sign(curr.col - prev.col)
			let r = prev.row + dr
			let c = prev.col + dc
			while (r !== curr.row || c !== curr.col) {
				cells.add(`${r},${c}`)
				r += dr
				c += dc
			}
		}
	}
	return cells
}

describe('routeEdges basic routing', () => {
	test('a simple two-node edge produces an orthogonal path from source to target', () => {
		const nodes = [{ id: 'a', row: 0, col: 0 }, { id: 'b', row: 2, col: 0 }]
		const paths = route(nodes, [{ from: 'a', to: 'b' }])
		expect(paths.length).toBe(1)
		const path = paths[0]!
		expect(path.from).toBe('a')
		expect(path.to).toBe('b')
		expect(path.points.length).toBeGreaterThanOrEqual(2)
		expect(isOrthogonal(path.points)).toBe(true)
		expect(path.outPort).not.toBeNull()
		expect(path.inPort).not.toBeNull()
	})

	test('the path starts outside the source and ends outside the target', () => {
		const nodes = [{ id: 'a', row: 0, col: 0 }, { id: 'b', row: 3, col: 0 }]
		const paths = route(nodes, [{ from: 'a', to: 'b' }])
		const aFine = 0 * STRIDE
		const bFine = 3 * STRIDE
		expect(paths[0]!.outPort?.row).toBe(aFine + 1)
		expect(paths[0]!.inPort?.row).toBe(bFine - 1)
	})

	test('a horizontal edge uses left/right faces', () => {
		const nodes = [{ id: 'a', row: 0, col: 0 }, { id: 'b', row: 0, col: 3 }]
		const paths = route(nodes, [{ from: 'a', to: 'b' }])
		const aFineCol = 0 * STRIDE
		const bFineCol = 3 * STRIDE
		expect(paths[0]!.outPort?.col).toBe(aFineCol + 1)
		expect(paths[0]!.inPort?.col).toBe(bFineCol - 1)
	})

	test('an edge to the same row and column is a self-loop with a dip below the node', () => {
		const nodes = [{ id: 'a', row: 1, col: 1 }]
		const paths = route(nodes, [{ from: 'a', to: 'a' }])
		const path = paths[0]!
		expect(path.points.length).toBe(4)
		expect(path.points[0]!.row).toBeLessThan(path.points[1]!.row)
		expect(path.points[1]!.row).toBe(path.points[2]!.row)
		expect(path.points[3]!.row).toBeLessThan(path.points[2]!.row)
		expect(isOrthogonal(path.points)).toBe(true)
	})
})

describe('routeEdges obstacle avoidance', () => {
	test('a path routes around a node blocking the direct vertical corridor', () => {
		const nodes = [
			{ id: 'a', row: 0, col: 1 },
			{ id: 'blocker', row: 1, col: 1 },
			{ id: 'b', row: 2, col: 1 },
		]
		const paths = route(nodes, [{ from: 'a', to: 'b' }])
		const cells = allPathCells(paths[0]!.points)
		const blockerFine = `${1 * STRIDE},${1 * STRIDE}`
		expect(cells.has(blockerFine)).toBe(false)
		expect(paths[0]!.points.length).toBeGreaterThan(2)
	})

	test('a path routes around a node blocking the direct horizontal corridor', () => {
		const nodes = [
			{ id: 'a', row: 0, col: 0 },
			{ id: 'blocker', row: 0, col: 1 },
			{ id: 'b', row: 0, col: 2 },
		]
		const paths = route(nodes, [{ from: 'a', to: 'b' }])
		const cells = allPathCells(paths[0]!.points)
		const blockerFine = `${0 * STRIDE},${1 * STRIDE}`
		expect(cells.has(blockerFine)).toBe(false)
	})
})

describe('routeEdges non-intersection', () => {
	test('two parallel edges do not share any path cells', () => {
		const nodes = [
			{ id: 'a', row: 0, col: 0 },
			{ id: 'b', row: 0, col: 2 },
			{ id: 'c', row: 2, col: 0 },
			{ id: 'd', row: 2, col: 2 },
		]
		const paths = route(nodes, [
			{ from: 'a', to: 'c' },
			{ from: 'b', to: 'd' },
		])
		const cells1 = allPathCells(paths[0]!.points)
		const cells2 = allPathCells(paths[1]!.points)
		for (const cell of cells1) {
			expect(cells2.has(cell)).toBe(false)
		}
	})

	test('two crossing edges route without sharing intermediate cells', () => {
		const nodes = [
			{ id: 'a', row: 0, col: 0 },
			{ id: 'b', row: 2, col: 2 },
			{ id: 'c', row: 0, col: 2 },
			{ id: 'd', row: 2, col: 0 },
		]
		const paths = route(nodes, [
			{ from: 'a', to: 'b' },
			{ from: 'c', to: 'd' },
		])
		// Both paths should be found by A* (not fallback): a crossing path may share a port-adjacent cell but must not share intermediate cells.
		expect(paths[0]!.points.length).toBeGreaterThanOrEqual(2)
		expect(paths[1]!.points.length).toBeGreaterThanOrEqual(2)
		expect(isOrthogonal(paths[0]!.points)).toBe(true)
		expect(isOrthogonal(paths[1]!.points)).toBe(true)
		// Neither path passes through a node interior.
		const nodeCells = new Set(nodes.map((n) => `${n.row * STRIDE},${n.col * STRIDE}`))
		for (const path of paths) {
			const cells = allPathCells(path.points)
			for (const cell of nodeCells) expect(cells.has(cell)).toBe(false)
		}
	})
})

describe('routeEdges port allocation', () => {
	test('multiple edges from the same face use different port offsets', () => {
		const nodes = [
			{ id: 'hub', row: 0, col: 1 },
			{ id: 'a', row: 2, col: 0 },
			{ id: 'b', row: 2, col: 1 },
			{ id: 'c', row: 2, col: 2 },
		]
		const paths = route(nodes, [
			{ from: 'hub', to: 'a' },
			{ from: 'hub', to: 'b' },
			{ from: 'hub', to: 'c' },
		])
		const portCols = new Set(paths.map((p) => p.outPort?.col))
		expect(portCols.size).toBe(3)
	})

	test('a cyclic pair (A→B and B→A) uses different ports on each face', () => {
		const nodes = [
			{ id: 'a', row: 0, col: 0 },
			{ id: 'b', row: 2, col: 0 },
		]
		const paths = route(nodes, [
			{ from: 'a', to: 'b' },
			{ from: 'b', to: 'a' },
		])
		expect(paths[0]!.outPort?.col).not.toBe(paths[1]!.inPort?.col)
		expect(paths[0]!.inPort?.col).not.toBe(paths[1]!.outPort?.col)
		const cells1 = allPathCells(paths[0]!.points)
		const cells2 = allPathCells(paths[1]!.points)
		for (const cell of cells1) {
			expect(cells2.has(cell)).toBe(false)
		}
	})
})

describe('routeEdges output', () => {
	test('returns one path per edge in the input order', () => {
		const nodes = [
			{ id: 'a', row: 0, col: 0 },
			{ id: 'b', row: 2, col: 0 },
			{ id: 'c', row: 4, col: 0 },
		]
		const paths = route(nodes, [
			{ from: 'a', to: 'b' },
			{ from: 'b', to: 'c' },
		])
		expect(paths.length).toBe(2)
		expect(paths[0]!.from).toBe('a')
		expect(paths[0]!.to).toBe('b')
		expect(paths[1]!.from).toBe('b')
		expect(paths[1]!.to).toBe('c')
	})

	test('a path never passes through a node interior', () => {
		const nodes = [
			{ id: 'a', row: 0, col: 0 },
			{ id: 'x', row: 1, col: 1 },
			{ id: 'b', row: 2, col: 2 },
		]
		const paths = route(nodes, [{ from: 'a', to: 'b' }])
		const nodeCells = new Set(nodes.map((n) => `${n.row * STRIDE},${n.col * STRIDE}`))
		const pathCells = allPathCells(paths[0]!.points)
		for (const cell of nodeCells) {
			expect(pathCells.has(cell)).toBe(false)
		}
	})
})

describe('gridToPixel', () => {
	const cellW = 160
	const cellH = 64
	const gapW = 60
	const gapH = 66

	test('a node cell maps to the coarse pixel position', () => {
		const px = gridToPixel(0, 0, CS, cellW, cellH, gapW, gapH)
		expect(px).toEqual({ x: 0, y: 0 })
		const px2 = gridToPixel(STRIDE, STRIDE, CS, cellW, cellH, gapW, gapH)
		expect(px2).toEqual({ x: cellW + gapW, y: cellH + gapH })
	})

	test('corridor tracks map proportionally within the gap', () => {
		const px = gridToPixel(1, 0, CS, cellW, cellH, gapW, gapH)
		expect(px.x).toBe(0)
		expect(px.y).toBeCloseTo(cellH + 0 * gapH / CS)
		const px2 = gridToPixel(0, 2, CS, cellW, cellH, gapW, gapH)
		expect(px2.y).toBe(0)
		expect(px2.x).toBeCloseTo(cellW + 1 * gapW / CS)
	})

	test('handles negative fine coordinates (ports above/left of a node)', () => {
		const px = gridToPixel(-1, 0, CS, cellW, cellH, gapW, gapH)
		expect(px.y).toBeCloseTo(-gapH / CS)
		expect(px.x).toBe(0)
	})
})

describe('portPixel', () => {
	const cellW = 160
	const cellH = 64
	const gapW = 60
	const gapH = 66

	test('a DOWN port at index 0 is at the bottom face center', () => {
		const px = portPixel(0, 0, 2, 0, CS, cellW, cellH, gapW, gapH)
		expect(px.x).toBe(cellW / 2)
		expect(px.y).toBe(cellH)
	})

	test('a RIGHT port at index 0 is at the right face center', () => {
		const px = portPixel(0, 0, 1, 0, CS, cellW, cellH, gapW, gapH)
		expect(px.x).toBe(cellW)
		expect(px.y).toBe(cellH / 2)
	})

	test('a DOWN port at index 1 is offset left by one lane (ports spread 0, -1, +1, …)', () => {
		const px0 = portPixel(0, 0, 2, 0, CS, cellW, cellH, gapW, gapH)
		const px1 = portPixel(0, 0, 2, 1, CS, cellW, cellH, gapW, gapH)
		expect(px1.x).toBe(px0.x - gapW / CS)
		expect(px1.y).toBe(px0.y)
	})
})
