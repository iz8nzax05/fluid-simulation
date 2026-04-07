'use strict'

var Slider = (function () {

    //changeCallback is called with the new value
    var Slider = function (element, initial, min, max, changeCallback) {
        this.value = initial;

        this.min = min;
        this.max = max;

        this.div = element;

        this.innerDiv = document.createElement('div');
        this.innerDiv.style.position = 'absolute';
        this.innerDiv.style.left = '0';
        this.innerDiv.style.top = '0';
        this.innerDiv.style.height = this.div.offsetHeight + 'px';

        this.div.appendChild(this.innerDiv);

        this.changeCallback = changeCallback;

        this.mousePressed = false;

        this.redraw();

        this.div.addEventListener('mousedown', (function (event) {
            this.mousePressed = true;
            this.onChange(event);
        }).bind(this));

        document.addEventListener('mouseup', (function (event) {
            this.mousePressed = false;
        }).bind(this));

        document.addEventListener('mousemove', (function (event) {
            if (this.mousePressed) {
                this.onChange(event);
            }
        }).bind(this));

    };

    Slider.prototype.redraw = function (isRetry) {
        var fraction = (this.value - this.min) / (this.max - this.min);
        var w = this.div.offsetWidth;
        var h = this.div.offsetHeight;
        if ((w === 0 || h === 0) && !isRetry) {
            var self = this;
            requestAnimationFrame(function () { self.redraw(true); });
            return;
        }
        this.innerDiv.style.width = (fraction * w) + 'px';
        this.innerDiv.style.height = h + 'px';
    }

    Slider.prototype.onChange = function (event) {
        var mouseX = Utilities.getMousePosition(event, this.div).x;
        this.value = Utilities.clamp((mouseX / this.div.offsetWidth) * (this.max - this.min) + this.min, this.min, this.max);

        this.redraw();

        this.changeCallback(this.value);
    }

    return Slider;
}());
