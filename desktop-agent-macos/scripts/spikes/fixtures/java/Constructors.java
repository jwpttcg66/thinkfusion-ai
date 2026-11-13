package com.acme.constructors;

public class Constructors extends Base {
    private final String id;

    public Constructors() {
        this("default");
    }

    public Constructors(String id) {
        super();
        this.id = id;
    }

    public Constructors(String id, Object... extra) {
        this(id);
    }

    public String id() {
        return id;
    }
}

class Base {
    protected Base() {
    }
}
