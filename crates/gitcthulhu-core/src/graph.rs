//! Lays commits out in lanes for the commit graph.
//!
//! Rows come in git's `--date-order`, children before parents. Each lane
//! waits for one commit. A commit takes the leftmost lane waiting for it, and
//! the other lanes waiting for it end at its dot. Its first parent then
//! inherits the lane; each further parent joins the lane already waiting for
//! it, or opens a new one. Freed lanes are reused, so the graph stays narrow.

use serde::Serialize;

/// Colors cycle through this many entries; the UI owns the palette.
pub const COLORS: u16 = 8;

#[derive(Debug, Clone)]
pub struct Node<'a> {
    pub oid: &'a str,
    pub parents: &'a [String],
    /// Stashes and the working-tree row draw dashed lines to their parent.
    pub dashed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RowLayout {
    pub lane: u16,
    pub color: u16,
    /// Lines from the row above into this row: from a lane at the row
    /// above's height to a lane at this row's height.
    pub edges: Vec<Edge>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub from: u16,
    pub to: u16,
    pub color: u16,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub dashed: bool,
}

#[derive(Debug, Clone)]
struct Slot {
    oid: String,
    color: u16,
    dashed: bool,
    /// Where this lane's line starts in the current row: its own lane, or
    /// the dot that opened it.
    source: u16,
}

/// A merge line into a lane that was already waiting for that parent.
#[derive(Debug, Clone)]
struct Join {
    from: u16,
    lane: usize,
    color: u16,
    dashed: bool,
}

pub fn layout(nodes: &[Node]) -> Vec<RowLayout> {
    let mut slots: Vec<Option<Slot>> = Vec::new();
    let mut joins: Vec<Join> = Vec::new();
    let mut next_color: u16 = 0;
    let mut alloc_color = || {
        let color = next_color;
        next_color = (next_color + 1) % COLORS;
        color
    };
    let mut rows = Vec::with_capacity(nodes.len());

    for node in nodes {
        let waiting: Vec<usize> = slots
            .iter()
            .enumerate()
            .filter(|(_, s)| s.as_ref().is_some_and(|s| s.oid == node.oid))
            .map(|(i, _)| i)
            .collect();
        let (lane, color) = match waiting.first() {
            Some(&lane) => (lane, slots[lane].as_ref().unwrap().color),
            None => (free_slot(&slots, None), alloc_color()),
        };
        let lane16 = lane as u16;

        let mut edges: Vec<Edge> = slots
            .iter()
            .enumerate()
            .filter_map(|(i, slot)| {
                let slot = slot.as_ref()?;
                let to = if slot.oid == node.oid {
                    lane16
                } else {
                    i as u16
                };
                Some(Edge {
                    from: slot.source,
                    to,
                    color: slot.color,
                    dashed: slot.dashed,
                })
            })
            .collect();
        edges.extend(joins.drain(..).map(|join| {
            let lands_here = slots[join.lane].as_ref().is_some_and(|s| s.oid == node.oid);
            Edge {
                from: join.from,
                to: if lands_here { lane16 } else { join.lane as u16 },
                color: join.color,
                dashed: join.dashed,
            }
        }));

        for &i in &waiting {
            slots[i] = None;
        }
        // Lines that continue start below their own lane in the next row.
        for (i, slot) in slots.iter_mut().enumerate() {
            if let Some(slot) = slot {
                slot.source = i as u16;
            }
        }

        if let Some((first, rest)) = node.parents.split_first() {
            put(
                &mut slots,
                lane,
                Slot {
                    oid: first.clone(),
                    color,
                    dashed: node.dashed,
                    source: lane16,
                },
            );
            for parent in rest {
                let existing = slots
                    .iter()
                    .position(|s| s.as_ref().is_some_and(|s| &s.oid == parent));
                match existing {
                    Some(j) => joins.push(Join {
                        from: lane16,
                        lane: j,
                        color: slots[j].as_ref().unwrap().color,
                        dashed: node.dashed,
                    }),
                    None => {
                        let j = free_slot(&slots, Some(lane));
                        let slot = Slot {
                            oid: parent.clone(),
                            color: alloc_color(),
                            dashed: node.dashed,
                            source: lane16,
                        };
                        put(&mut slots, j, slot);
                    }
                }
            }
        }
        while matches!(slots.last(), Some(None)) {
            slots.pop();
        }

        rows.push(RowLayout {
            lane: lane16,
            color,
            edges,
        });
    }
    rows
}

fn free_slot(slots: &[Option<Slot>], except: Option<usize>) -> usize {
    slots
        .iter()
        .enumerate()
        .position(|(i, s)| s.is_none() && Some(i) != except)
        .unwrap_or(slots.len().max(except.map_or(0, |e| e + 1)))
}

fn put(slots: &mut Vec<Option<Slot>>, i: usize, slot: Slot) {
    if slots.len() <= i {
        slots.resize(i + 1, None);
    }
    slots[i] = Some(slot);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(commits: &[(&str, &[&str])]) -> Vec<RowLayout> {
        let parents: Vec<Vec<String>> = commits
            .iter()
            .map(|(_, ps)| ps.iter().map(|p| p.to_string()).collect())
            .collect();
        let nodes: Vec<Node> = commits
            .iter()
            .zip(&parents)
            .map(|((oid, _), parents)| Node {
                oid,
                parents,
                dashed: false,
            })
            .collect();
        layout(&nodes)
    }

    fn lanes(rows: &[RowLayout]) -> Vec<u16> {
        rows.iter().map(|r| r.lane).collect()
    }

    fn pairs(row: &RowLayout) -> Vec<(u16, u16)> {
        let mut p: Vec<_> = row.edges.iter().map(|e| (e.from, e.to)).collect();
        p.sort();
        p
    }

    #[test]
    fn a_straight_history_uses_one_lane() {
        let rows = run(&[("c", &["b"]), ("b", &["a"]), ("a", &[])]);
        assert_eq!(lanes(&rows), [0, 0, 0]);
        assert!(rows[0].edges.is_empty());
        assert_eq!(pairs(&rows[1]), [(0, 0)]);
        assert_eq!(pairs(&rows[2]), [(0, 0)]);
        assert!(rows.iter().all(|r| r.color == rows[0].color));
    }

    #[test]
    fn a_merge_opens_a_lane_that_closes_at_the_fork() {
        // m merges f into b; f and b both come from a.
        let rows = run(&[("m", &["b", "f"]), ("f", &["a"]), ("b", &["a"]), ("a", &[])]);
        assert_eq!(lanes(&rows), [0, 1, 0, 0]);
        // From the merge dot down to f, on lane 1.
        assert_eq!(pairs(&rows[1]), [(0, 0), (0, 1)]);
        // Both lanes wait for a; they meet at its dot.
        assert_eq!(pairs(&rows[2]), [(0, 0), (1, 1)]);
        assert_eq!(pairs(&rows[3]), [(0, 0), (1, 0)]);
        assert_ne!(rows[1].color, rows[0].color);
    }

    #[test]
    fn two_branch_tips_get_their_own_lanes() {
        let rows = run(&[("x", &["a"]), ("y", &["a"]), ("a", &[])]);
        assert_eq!(lanes(&rows), [0, 1, 0]);
        assert_eq!(pairs(&rows[2]), [(0, 0), (1, 0)]);
    }

    #[test]
    fn merging_a_parent_that_already_has_a_lane_joins_it() {
        // t's lane already waits for a when m (on another branch) merges a.
        let rows = run(&[
            ("t", &["a"]),
            ("m", &["b", "a"]),
            ("b", &["z"]),
            ("a", &["z"]),
            ("z", &[]),
        ]);
        assert_eq!(lanes(&rows), [0, 1, 1, 0, 0]);
        // Row b: the merge line from m (lane 1) joins lane 0 rather than opening lane 2.
        assert_eq!(pairs(&rows[2]), [(0, 0), (1, 0), (1, 1)]);
        assert!(
            rows.iter()
                .all(|r| r.edges.iter().all(|e| e.from < 2 && e.to < 2))
        );
    }

    #[test]
    fn freed_lanes_are_reused() {
        let rows = run(&[
            ("m2", &["m1", "g"]),
            ("g", &["m1"]),
            ("m1", &["b", "f"]),
            ("f", &["a"]),
            ("b", &["a"]),
            ("a", &[]),
        ]);
        assert_eq!(lanes(&rows), [0, 1, 0, 1, 0, 0]);
    }

    #[test]
    fn history_cut_off_by_the_limit_keeps_its_lanes_open() {
        // a's parent isn't loaded; nothing panics and the lane just runs on.
        let rows = run(&[("b", &["a"]), ("a", &["missing"])]);
        assert_eq!(lanes(&rows), [0, 0]);
    }

    #[test]
    fn dashed_nodes_draw_dashed_lines_to_their_parent() {
        let parents = [vec!["a".to_owned()], vec![]];
        let nodes = [
            Node {
                oid: "stash",
                parents: &parents[0],
                dashed: true,
            },
            Node {
                oid: "a",
                parents: &parents[1],
                dashed: false,
            },
        ];
        let rows = layout(&nodes);
        assert!(rows[1].edges[0].dashed);
    }
}
