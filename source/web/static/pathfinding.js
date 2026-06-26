// Orthogonal edge routing on a grid board.
//
// Nodes occupy cells on a coarse grid. Corridors between cells are `corridorSize` fine cells wide, providing lanes for paths to travel without intersecting. Each edge is routed as an orthogonal path from the source's out-face to the target's in-face, where the faces are determined by the relative positions of source and target (so the library works in any orientation — top-to-bottom or left-to-right). Paths avoid node interiors and cells reserved by previously routed paths. When multiple edges share a node face, port slots spread outward from the face center (0, +1, -1, +2, -2, …).
//
// The library is browser-pure (no imports) so the dev playback harness and the live run-view client load it the same way, and the in-memory test module imports it from the filesystem. It returns grid-coordinate paths; `gridToPixel` converts those to rendering coordinates.

export const DEFAULT_CORRIDOR_SIZE = 6
export const DEFAULT_TURN_PENALTY = 0.4

const UP = 0
const RIGHT = 1
const DOWN = 2
const LEFT = 3

const DIR_DELTA = [
	{ dr: -1, dc: 0 },
	{ dr: 0, dc: 1 },
	{ dr: 1, dc: 0 },
	{ dr: 0, dc: -1 },
]

const OPPOSITE = [DOWN, LEFT, UP, RIGHT]

// Port offset sequence: 0, +1, -1, +2, -2, +3, -3, … — spreads outward from the face center so cycles that need multiple ports on one face don't pile up on one side.
function portOffset(index) {
	const half = Math.floor(index / 2)
	return index % 2 === 0 ? half : -(half + 1)
}

function coarseToFine(coarse, corridorSize) {
	return coarse * (1 + corridorSize)
}

function fineGridDimensions(maxCoarseRow, maxCoarseCol, corridorSize) {
	const stride = 1 + corridorSize
	return { rows: (maxCoarseRow + 1) * stride, cols: (maxCoarseCol + 1) * stride }
}

// Determines which face of the source the edge leaves from (out) and which face of the target it arrives at (in), based on their relative positions. For a self-loop (source === target), both faces are DOWN so the loop dips below the node.
function facesForEdge(rA, cA, rB, cB) {
	if (rA === rB && cA === cB) return { outFace: DOWN, inFace: DOWN }
	const dr = rB - rA
	const dc = cB - cA
	if (Math.abs(dr) >= Math.abs(dc)) {
		return dr > 0 ? { outFace: DOWN, inFace: UP } : { outFace: UP, inFace: DOWN }
	}
	return dc > 0 ? { outFace: RIGHT, inFace: LEFT } : { outFace: LEFT, inFace: RIGHT }
}

// The port grid cell sits one step outside the node on the chosen face, offset along the face's cross-axis.
function portCell(nodeFineRow, nodeFineCol, face, offset) {
	switch (face) {
		case UP: return { row: nodeFineRow - 1, col: nodeFineCol + offset }
		case DOWN: return { row: nodeFineRow + 1, col: nodeFineCol + offset }
		case RIGHT: return { row: nodeFineRow + offset, col: nodeFineCol + 1 }
		case LEFT: return { row: nodeFineRow + offset, col: nodeFineCol - 1 }
	}
}

function cellKey(row, col) {
	return `${row},${col}`
}

function stateKey(row, col, dir) {
	return `${row},${col},${dir}`
}

function manhattan(r1, c1, r2, c2) {
	return Math.abs(r1 - r2) + Math.abs(c1 - c2)
}

// A* on the fine grid. State includes the entry direction so a turn penalty can prefer fewer elbows. `blocked` is a Set of "row,col" strings for impassable cells (node interiors and previously reserved path cells). Returns the full cell list (including start and end) or null if no path exists.
function findPath(startRow, startCol, endRow, endCol, startDir, blocked, gridRows, gridCols, turnPenalty) {
	const open = [{ row: startRow, col: startCol, dir: startDir, g: 0, f: manhattan(startRow, startCol, endRow, endCol) }]
	const gScore = new Map()
	const cameFrom = new Map()
	gScore.set(stateKey(startRow, startCol, startDir), 0)

	while (open.length > 0) {
		let bestIdx = 0
		for (let i = 1; i < open.length; i++) {
			if (open[i].f < open[bestIdx].f) bestIdx = i
		}
		const current = open.splice(bestIdx, 1)[0]

		if (current.row === endRow && current.col === endCol) {
			const path = [{ row: current.row, col: current.col }]
			let key = stateKey(current.row, current.col, current.dir)
			while (cameFrom.has(key)) {
				const prev = cameFrom.get(key)
				path.unshift({ row: prev.row, col: prev.col })
				key = stateKey(prev.row, prev.col, prev.dir)
			}
			return path
		}

		const currentG = gScore.get(stateKey(current.row, current.col, current.dir))
		for (let dir = 0; dir < 4; dir++) {
			const delta = DIR_DELTA[dir]
			const nr = current.row + delta.dr
			const nc = current.col + delta.dc
			if (nr < 0 || nr >= gridRows || nc < 0 || nc >= gridCols) continue
			if (blocked.has(cellKey(nr, nc))) continue
			const turnCost = dir !== current.dir ? turnPenalty : 0
			const tentativeG = currentG + 1 + turnCost
			const nKey = stateKey(nr, nc, dir)
			if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
				gScore.set(nKey, tentativeG)
				cameFrom.set(nKey, { row: current.row, col: current.col, dir: current.dir })
				open.push({ row: nr, col: nc, dir, g: tentativeG, f: tentativeG + manhattan(nr, nc, endRow, endCol) })
			}
		}
	}
	return null
}

// Removes intermediate cells that are collinear, leaving only the elbow points plus start and end. This is what the renderer turns into an SVG polyline.
function simplifyPath(cells) {
	if (cells.length <= 2) return cells
	const result = [cells[0]]
	for (let i = 1; i < cells.length - 1; i++) {
		const prev = cells[i - 1]
		const curr = cells[i]
		const next = cells[i + 1]
		const dr1 = curr.row - prev.row
		const dc1 = curr.col - prev.col
		const dr2 = next.row - curr.row
		const dc2 = next.col - curr.col
		if (dr1 !== dr2 || dc1 !== dc2) result.push(curr)
	}
	result.push(cells[cells.length - 1])
	return result
}

// A self-loop leaves the node's bottom face from one port, dips into the corridor below, and re-enters from another port on the same face. The dip depth grows with the port index so multiple self-loops on the same node stack without overlapping.
function routeSelfLoop(nodeFineRow, nodeFineCol, outPortIdx, inPortIdx, corridorSize, blocked) {
	const outOff = portOffset(outPortIdx)
	const inOff = portOffset(inPortIdx)
	const outPort = portCell(nodeFineRow, nodeFineCol, DOWN, outOff)
	const inPort = portCell(nodeFineRow, nodeFineCol, DOWN, inOff)
	const dipDepth = Math.max(2, Math.floor(corridorSize / 2) + Math.max(Math.abs(outOff), Math.abs(inOff)))
	const dipRow = nodeFineRow + dipDepth
	return {
		points: [
			outPort,
			{ row: dipRow, col: nodeFineCol + outOff },
			{ row: dipRow, col: nodeFineCol + inOff },
			inPort,
		],
		outPort,
		inPort,
		blockedCells: [
			cellKey(outPort.row, outPort.col),
			cellKey(inPort.row, inPort.col),
			cellKey(dipRow, nodeFineCol + outOff),
			cellKey(dipRow, nodeFineCol + inOff),
			...Array.from({ length: dipDepth - 1 }, (_, i) => cellKey(nodeFineRow + 1 + i, nodeFineCol + outOff)),
			...Array.from({ length: dipDepth - 1 }, (_, i) => cellKey(nodeFineRow + 1 + i, nodeFineCol + inOff)),
			...Array.from({ length: Math.abs(inOff - outOff) }, (_, i) => cellKey(dipRow, nodeFineCol + outOff + Math.sign(inOff - outOff) * (i + 1))),
		],
	}
}

// Routes a set of edges on a grid board, returning one path per edge (in the same order as the input). Each path is a list of grid cells (elbow points only) from the source's out-port to the target's in-port. Paths are routed longest-first and cells are reserved as each path is found, so later paths route around earlier ones. Self-loops are handled separately from A*. If A* cannot find a path (the board is fully congested), a fallback straight line is returned so the renderer still draws something.
export function routeEdges(nodes, edges, options) {
	const corridorSize = options?.corridorSize ?? DEFAULT_CORRIDOR_SIZE
	const turnPenalty = options?.turnPenalty ?? DEFAULT_TURN_PENALTY

	const nodeMap = new Map(nodes.map((n) => [n.id, n]))
	let maxCoarseRow = 0
	let maxCoarseCol = 0
	for (const node of nodes) {
		if (node.row > maxCoarseRow) maxCoarseRow = node.row
		if (node.col > maxCoarseCol) maxCoarseCol = node.col
	}
	const { rows: gridRows, cols: gridCols } = fineGridDimensions(maxCoarseRow, maxCoarseCol, corridorSize)

	const blocked = new Set()
	for (const node of nodes) {
		blocked.add(cellKey(coarseToFine(node.row, corridorSize), coarseToFine(node.col, corridorSize)))
	}

	const portCounters = new Map()
	function nextPortIndex(nodeId, face) {
		const key = `${nodeId}:${face}`
		const idx = portCounters.get(key) ?? 0
		portCounters.set(key, idx + 1)
		return idx
	}

	const order = edges.map((edge, idx) => {
		const src = nodeMap.get(edge.from)
		const tgt = nodeMap.get(edge.to)
		const dist = src && tgt ? manhattan(src.row, src.col, tgt.row, tgt.col) : 0
		return { idx, edge, dist }
	}).sort((a, b) => b.dist - a.dist)

	const results = new Array(edges.length)

	for (const { idx, edge } of order) {
		const src = nodeMap.get(edge.from)
		const tgt = nodeMap.get(edge.to)
		if (!src || !tgt) {
			results[idx] = { from: edge.from, to: edge.to, points: [], outPort: null, inPort: null }
			continue
		}

		const sFr = coarseToFine(src.row, corridorSize)
		const sFc = coarseToFine(src.col, corridorSize)
		const tFr = coarseToFine(tgt.row, corridorSize)
		const tFc = coarseToFine(tgt.col, corridorSize)

		if (edge.from === edge.to) {
			const outIdx = nextPortIndex(edge.from, DOWN)
			const inIdx = nextPortIndex(edge.to, DOWN)
			const loop = routeSelfLoop(sFr, sFc, outIdx, inIdx, corridorSize, blocked)
			for (const key of loop.blockedCells) blocked.add(key)
			results[idx] = { from: edge.from, to: edge.to, points: loop.points, outPort: loop.outPort, inPort: loop.inPort }
			continue
		}

		const { outFace, inFace } = facesForEdge(src.row, src.col, tgt.row, tgt.col)

		let routed = null
		const maxPortTries = Math.max(corridorSize * 2, 12)
		for (let attempt = 0; attempt < maxPortTries && routed === null; attempt++) {
			const outIdx = nextPortIndex(edge.from, outFace)
			const inIdx = nextPortIndex(edge.to, inFace)
			const outPort = portCell(sFr, sFc, outFace, portOffset(outIdx))
			const inPort = portCell(tFr, tFc, inFace, portOffset(inIdx))
			if (outPort.row < 0 || outPort.row >= gridRows || outPort.col < 0 || outPort.col >= gridCols) continue
			if (inPort.row < 0 || inPort.row >= gridRows || inPort.col < 0 || inPort.col >= gridCols) continue
			if (blocked.has(cellKey(outPort.row, outPort.col)) || blocked.has(cellKey(inPort.row, inPort.col))) continue
			const path = findPath(outPort.row, outPort.col, inPort.row, inPort.col, outFace, blocked, gridRows, gridCols, turnPenalty)
			if (path !== null) {
				routed = { points: simplifyPath(path), outPort, inPort, rawPath: path }
			}
		}

		if (routed === null) {
			const outIdx = (portCounters.get(`${edge.from}:${outFace}`) ?? 1) - 1
			const inIdx = (portCounters.get(`${edge.to}:${inFace}`) ?? 1) - 1
			const outPort = portCell(sFr, sFc, outFace, portOffset(outIdx))
			const inPort = portCell(tFr, tFc, inFace, portOffset(inIdx))
			// Fallback L-shaped path (horizontal-then-vertical or vice versa) so the renderer draws an orthogonal line even when the board is fully congested. This may overlap other paths, but at least the edge is visible.
			const midRow = outPort.row === inPort.row ? outPort.row : outPort.row
			const midCol = outPort.col === inPort.col ? outPort.col : inPort.col
			results[idx] = { from: edge.from, to: edge.to, points: [outPort, { row: midRow, col: midCol }, inPort].filter((p, i, arr) => i === 0 || i === arr.length - 1 || (p.row !== arr[i - 1].row || p.col !== arr[i - 1].col)), outPort, inPort }
			continue
		}

		// Reserve intermediate path cells (not the start/end port cells, which other edges may need to enter/leave through their own ports at different offsets). This trades a small chance of visual overlap near a port for the ability to always reach a target whose corridor has been crossed by a previous path — the alternative is a blocked in-port and a fallback diagonal.
		for (let i = 1; i < routed.rawPath.length - 1; i++) {
			blocked.add(cellKey(routed.rawPath[i].row, routed.rawPath[i].col))
		}
		results[idx] = { from: edge.from, to: edge.to, points: routed.points, outPort: routed.outPort, inPort: routed.inPort }
	}

	return results
}

// Converts a fine-grid position to a pixel coordinate. Each coarse cell is `cellW`×`cellH` pixels; the corridor between cells is `gapW`×`gapH` pixels, divided into `corridorSize` tracks. A node cell maps to the node's top-left pixel; a corridor track maps proportionally within the gap.
export function gridToPixel(fineRow, fineCol, corridorSize, cellW, cellH, gapW, gapH) {
	const stride = 1 + corridorSize
	const coarseRow = Math.floor(fineRow / stride)
	const coarseCol = Math.floor(fineCol / stride)
	const rowOff = ((fineRow % stride) + stride) % stride
	const colOff = ((fineCol % stride) + stride) % stride
	const x = colOff === 0
		? coarseCol * (cellW + gapW)
		: coarseCol * (cellW + gapW) + cellW + (colOff - 1) * gapW / corridorSize
	const y = rowOff === 0
		? coarseRow * (cellH + gapH)
		: coarseRow * (cellH + gapH) + cellH + (rowOff - 1) * gapH / corridorSize
	return { x, y }
}

// The pixel position of a port on a node face. Unlike gridToPixel (which maps the corridor cell the path starts in), this places the port at the node's face edge, centered along the face, then offset by the port index times one lane width. This is what the SVG path's first and last points should use so the line visually connects to the node box, not to a corridor cell center.
export function portPixel(nodeFineRow, nodeFineCol, face, portIdx, corridorSize, cellW, cellH, gapW, gapH) {
	const laneW = gapW / corridorSize
	const laneH = gapH / corridorSize
	const off = portOffset(portIdx)
	const px = Math.floor(nodeFineCol / (1 + corridorSize)) * (cellW + gapW)
	const py = Math.floor(nodeFineRow / (1 + corridorSize)) * (cellH + gapH)
	switch (face) {
		case UP: return { x: px + cellW / 2 + off * laneW, y: py }
		case DOWN: return { x: px + cellW / 2 + off * laneW, y: py + cellH }
		case RIGHT: return { x: px + cellW, y: py + cellH / 2 + off * laneH }
		case LEFT: return { x: px, y: py + cellH / 2 + off * laneH }
	}
	return { x: px, y: py }
}
