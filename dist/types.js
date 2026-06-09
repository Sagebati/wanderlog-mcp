export function isPlaceBlock(block) {
    return block.type === "place" && "place" in block && !!block.place;
}
export function isChecklistBlock(block) {
    return block.type === "checklist" && "items" in block;
}
//# sourceMappingURL=types.js.map