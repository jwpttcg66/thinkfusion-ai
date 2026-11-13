package com.acme.interfaces;

public interface InterfaceDefaults {
    default String name() {
        return "default";
    }

    static int count() {
        return 1;
    }

    private void helper() {
        name();
    }

    interface Child extends InterfaceDefaults, Comparable<Child> {
        @Override
        default int compareTo(Child other) {
            return name().compareTo(other.name());
        }
    }
}
