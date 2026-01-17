
import fs from 'fs';
import path from 'path';

export interface GraphNode {
    id: string; // unique identifier (e.g., file path or function signature)
    type: 'FILE' | 'FUNCTION' | 'API' | 'COMPONENT';
    label: string;
    metadata?: any;
}

export interface GraphEdge {
    source: string;
    target: string;
    type: 'IMPORTS' | 'CALLS' | 'DEFINES' | 'EXPOSES' | 'USED_BY';
    metadata?: any;
}

export interface GraphData {
    nodes: GraphNode[];
    edges: GraphEdge[];
}

const GRAPH_FILE = path.join(process.cwd(), 'data', 'graph.json');

export class GraphService {
    private nodes: Map<string, GraphNode> = new Map();
    private edges: GraphEdge[] = [];
    private graphFile: string;

    constructor(projectId?: string) {
        if (projectId) {
            this.graphFile = path.join(process.cwd(), 'data', `graph-${projectId}.json`);
        } else {
            this.graphFile = path.join(process.cwd(), 'data', 'graph.json');
        }
        this.load();
    }

    private load() {
        if (fs.existsSync(this.graphFile)) {
            const data = JSON.parse(fs.readFileSync(this.graphFile, 'utf-8'));
            this.nodes = new Map(data.nodes.map((n: GraphNode) => [n.id, n]));
            this.edges = data.edges;
        } else {
            // Ensure data directory exists
            const dir = path.dirname(this.graphFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }
    }

    public save() {
        const data: GraphData = {
            nodes: Array.from(this.nodes.values()),
            edges: this.edges,
        };
        fs.writeFileSync(this.graphFile, JSON.stringify(data, null, 2));
    }

    public addNode(node: GraphNode) {
        if (!this.nodes.has(node.id)) {
            this.nodes.set(node.id, node);
        }
    }

    public addEdge(edge: GraphEdge) {
        // Avoid duplicate edges
        const exists = this.edges.some(
            (e) =>
                e.source === edge.source &&
                e.target === edge.target &&
                e.type === edge.type
        );
        if (!exists) {
            this.edges.push(edge);
        }
    }

    public getGraph(): GraphData {
        return {
            nodes: Array.from(this.nodes.values()),
            edges: this.edges,
        };
    }

    public clear() {
        this.nodes.clear();
        this.edges = [];
        this.save();
    }

    public removeNodesByRepoId(repoId: string) {
        // 1. Identify nodes to remove (where metadata.repoId == repoId)
        const nodesToRemove = Array.from(this.nodes.values())
            .filter(node => node.metadata && node.metadata.repoId === repoId)
            .map(node => node.id);

        // 2. Remove nodes
        nodesToRemove.forEach(id => this.nodes.delete(id));

        // 3. Remove edges connected to these nodes
        this.edges = this.edges.filter(edge =>
            !nodesToRemove.includes(edge.source) && !nodesToRemove.includes(edge.target)
        );

        this.save();
        console.log(`[GRAPH] Removed ${nodesToRemove.length} nodes for repo ${repoId}`);
    }
}
