package com.acme.sealed;

public sealed interface Sealed permits A, B {
}

final class A implements Sealed {
}

non-sealed class B implements Sealed {
}

sealed class C permits D {
}

final class D extends C {
}
