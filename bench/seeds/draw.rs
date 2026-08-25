use crate::shapes::{centre, rect_path, Point, Rect};

pub struct Canvas {
    pub commands: Vec<String>,
}

impl Canvas {
    pub fn new() -> Self {
        Self { commands: Vec::new() }
    }

    pub fn move_to(&mut self, point: Point) {
        self.commands.push(format!("M {} {}", point.x, point.y));
    }

    pub fn line_to(&mut self, point: Point) {
        self.commands.push(format!("L {} {}", point.x, point.y));
    }

    pub fn close(&mut self) {
        self.commands.push("Z".to_string());
    }
}

pub fn draw_rect(canvas: &mut Canvas, shape: &Rect, corner_radius: f64) {
    let path = rect_path(shape, corner_radius);
    let Some((first, rest)) = path.split_first() else {
        return;
    };
    canvas.move_to(*first);
    for point in rest {
        canvas.line_to(*point);
    }
    canvas.close();
}

pub fn draw_crosshair(canvas: &mut Canvas, shape: &Rect) {
    let middle = centre(shape);
    canvas.move_to(Point { x: middle.x, y: shape.origin.y });
    canvas.line_to(Point { x: middle.x, y: shape.origin.y + shape.height });
}
