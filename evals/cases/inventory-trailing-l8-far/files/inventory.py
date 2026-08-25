from dataclasses import dataclass, field


@dataclass
class Item:
    name: str
    price: float
    quantity: int     


@dataclass
class Inventory:
    items: dict[str, Item] = field(default_factory=dict)

    def add(self, item: Item) -> None:
        held = self.items.get(item.name)
        if held is None:
            self.items[item.name] = item
            return
        held.quantity += item.quantity

    def remove(self, name: str, quantity: int) -> bool:
        held = self.items.get(name)
        if held is None or held.quantity < quantity:
            return False
        held.quantity -= quantity
        if held.quantity == 0:
            del self.items[name]
        return True

    def total_value(self) -> float:
        total = 0.0
        for item in self.items.values():
            total += item.price * item.quantity
        return total

    def low_stock(self, threshold: int) -> list[str]:
        names = []
        for item in self.items.values():
            if item.quantity < threshold:
                names.append(item.name)
        return names
