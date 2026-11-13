package com.acme.switches;

public class Switches {
    public String describe(Object value) {
        return switch (value) {
            case Integer number -> "int:" + number;
            case String text -> "text:" + text;
            case null -> "null";
            default -> "other";
        };
    }

    public int yieldSwitch(int code) {
        return switch (code) {
            case 1 -> 10;
            case 2 -> {
                int base = 20;
                yield base + 1;
            }
            default -> 0;
        };
    }

    public String pattern(Object value) {
        if (value instanceof String text && !text.isBlank()) {
            return text;
        }
        return "";
    }
}
