package com.acme.types;

import java.util.function.Supplier;

/** Gate 0 Tree-sitter fixture: records, sealed types, enum, annotation and nested classes. */
public sealed interface Shape permits Circle, Square {
    double area();
}

record Circle(double radius) implements Shape {
    public double area() {
        return Math.PI * radius * radius;
    }
}

final class Square implements Shape {
    private final double side;

    Square(double side) {
        this.side = side;
    }

    public double area() {
        return side * side;
    }
}

enum Color {
    RED,
    GREEN
}

@interface Marker {
    String value();
}

class Outer {
    static class Inner {
    }

    void run() {
        Runnable anonymous = new Runnable() {
            public void run() {
            }
        };
        Runnable lambda = () -> {
        };
        Supplier<String> reference = this::toString;
        switch (anonymous) {
            case Runnable value -> value.run();
            default -> {
            }
        }
    }
}
